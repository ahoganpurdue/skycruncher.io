// ═══════════════════════════════════════════════════════════════════════════
// M3 conformance — fixture generator.
//
// Builds the synthetic + real (CSM30799) + composed-path fixture set, runs the
// TS oracle (via run_oracle.mjs, esbuild-transpiled READ-ONLY) on each, embeds
// the oracle result as `expected`, and writes one JSON per fixture into
//   crates/solver-core/tests/fixtures/verify/
// plus a MANIFEST.json with provenance. Deterministic: seeded PRNG, banked
// inputs only. Re-running overwrites identically (byte-stable modulo `generatedAt`).
//
// Real-data sources (banked, READ-ONLY):
//   label      D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18/CSM30799.label.json
//   detections D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18/A/detections/detections_CSM30799.CR2_16792.json
//   junk poses D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/test1d_csm30799/clusters_CSM30799.CR2_18112.json
//   catalog    D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow
//
// Usage: node gen_fixtures.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { loadVerifyModule, runFixture, TS_ORACLE_PATH } from './run_oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'solver-core', 'tests', 'fixtures', 'verify');
const MAIN_REPO_PKG =
  'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY/package.json';

const LABEL_PATH = 'D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18/CSM30799.label.json';
const DET_PATH =
  'D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18/A/detections/detections_CSM30799.CR2_16792.json';
const CLUSTERS_PATH =
  'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/test1d_csm30799/clusters_CSM30799.CR2_18112.json';
const STARS_ARROW =
  'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow';

const DEFAULT_OPTS = () => ({
  verifyPixSigma: 3.0,
  distractor: 0.25,
  maxMatchSigma: 5.0,
  doGamma: true,
  doRoR: true,
  effAreaGridN: 16,
  logBail: Math.log(1e-100),
  logStop: null, // null encodes +Infinity
});

// ── deterministic PRNG ──────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}
function assert(cond, msg) {
  if (!cond) throw new Error('fixture sanity FAILED: ' + msg);
}

// ── synthetic scene helpers ─────────────────────────────────────────────────
// refs constrained to y ∈ [60, 780] so the y ∈ [880, 980] band is guaranteed
// ref-free — distractors placed there can NEVER match (max gamma'd 5σ radius in
// these scenes ≈ 26 px « 100 px gap).
function randRefs(rng, n, W, avoid = [], avoidR = 90) {
  const refs = [];
  let guard = 0;
  while (refs.length < n && guard++ < 20000) {
    const x = 60 + rng() * (W - 120);
    const y = 60 + rng() * 720;
    if (avoid.some((a) => dist2(a[0], a[1], x, y) < avoidR * avoidR)) continue;
    refs.push([x, y]);
  }
  assert(refs.length === n, 'randRefs under-filled');
  return refs;
}
function distractorAt(rng, W) {
  return [60 + rng() * (W - 120), 880 + rng() * 100];
}

/** Standard synthetic scene: nMatch tests jittered on refs[0..nMatch), then
 *  nDistract tests in the ref-free band. Brightness strictly descending. */
function baseScene(seed, { W = 1000, H = 1000, nRef = 40, nMatch = 20, jitterPx = 1.0, nDistract = 10, avoid = [] } = {}) {
  const rng = mulberry32(seed);
  const refs = randRefs(rng, nRef, W, avoid);
  const tests = [];
  let bright = 1000;
  const nextBright = () => (bright -= 3 + rng());
  for (let i = 0; i < nMatch; i++) {
    const r = refs[i];
    tests.push([r[0] + gauss(rng) * jitterPx, r[1] + gauss(rng) * jitterPx, nextBright()]);
  }
  for (let i = 0; i < nDistract; i++) {
    const d = distractorAt(rng, W);
    tests.push([d[0], d[1], nextBright()]);
  }
  return { W, H, refs, tests, rng, nextBright };
}
const CENTER_QUAD = { cx: 500, cy: 500, quadR2: 250000 };

// ── TAN WCS helpers (fixture-grade plain TAN; both sides only ever see px) ──
const D2R = Math.PI / 180;
function makeTan(raDeg, decDeg, scaleAsec, rotDeg, parity, W, H) {
  const s = scaleAsec / 3600;
  const th = rotDeg * D2R;
  return {
    ra0: raDeg, dec0: decDeg, crpix: [W / 2, H / 2], W, H,
    cd: [
      [s * Math.cos(th) * parity, -s * Math.sin(th)],
      [s * Math.sin(th) * parity, s * Math.cos(th)],
    ],
  };
}
function skyToPx(wcs, raDeg, decDeg) {
  const ra = raDeg * D2R, dec = decDeg * D2R;
  const ra0 = wcs.ra0 * D2R, dec0 = wcs.dec0 * D2R;
  const sd = Math.sin(dec), cd = Math.cos(dec);
  const sd0 = Math.sin(dec0), cd0 = Math.cos(dec0);
  const cdra = Math.cos(ra - ra0);
  const cosc = sd0 * sd + cd0 * cd * cdra;
  if (cosc <= 0.1) return null;
  const xi = (cd * Math.sin(ra - ra0)) / cosc / D2R;
  const eta = (cd0 * sd - sd0 * cd * cdra) / cosc / D2R;
  const [[a, b], [c, d]] = wcs.cd;
  const det = a * d - b * c;
  const dx = (d * xi - b * eta) / det;
  const dy = (-c * xi + a * eta) / det;
  return [wcs.crpix[0] + dx, wcs.crpix[1] + dy];
}
function angSepDeg(ra1, dec1, ra2, dec2) {
  const c =
    Math.sin(dec1 * D2R) * Math.sin(dec2 * D2R) +
    Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.cos((ra1 - ra2) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
}

// ── real data loaders ───────────────────────────────────────────────────────
function loadCatalog() {
  const require2 = createRequire(MAIN_REPO_PKG);
  const arrow = require2('apache-arrow');
  const t = arrow.tableFromIPC(readFileSync(STARS_ARROW));
  return { ra: t.getChild('ra_deg').toArray(), dec: t.getChild('dec_deg').toArray(), n: t.numRows };
}
/** Brightest maxN catalog stars projected in-frame (row order = brightness rank). */
function gatherRefs(cat, wcs, maxN) {
  const out = [];
  for (let i = 0; i < cat.n && out.length < maxN; i++) {
    const p = skyToPx(wcs, cat.ra[i], cat.dec[i]);
    if (p && p[0] >= 0 && p[0] < wcs.W && p[1] >= 0 && p[1] < wcs.H) out.push([p[0], p[1]]);
  }
  return out;
}
function loadDetections(maxN) {
  const j = JSON.parse(readFileSync(DET_PATH, 'utf8'));
  const rows = j.detections.slice().sort((a, b) => (b.flux - a.flux) || (a.id - b.id));
  return rows.slice(0, maxN).map((r) => [r.x, r.y, r.flux]);
}

/** Pick two bright detections: A central-ish, B at separation in [minSep,maxSep]. */
function pickAnchorPair(tests, W, H, minSep, maxSep) {
  for (let i = 0; i < tests.length; i++) {
    const a = tests[i];
    if (a[0] < W / 3 || a[0] > (2 * W) / 3 || a[1] < H / 3 || a[1] > (2 * H) / 3) continue;
    for (let j = 0; j < tests.length; j++) {
      if (j === i) continue;
      const s2 = dist2(a[0], a[1], tests[j][0], tests[j][1]);
      if (s2 >= minSep * minSep && s2 <= maxSep * maxSep) return [i, j];
    }
  }
  throw new Error('pickAnchorPair: no pair found');
}
function anetQuad(detA, detB) {
  const cx = (detA[0] + detB[0]) / 2;
  const cy = (detA[1] + detB[1]) / 2;
  return { cx, cy, quadR2: dist2(cx, cy, detA[0], detA[1]) };
}

// ── ulp helpers (tie fixture) + f64 bit transport ───────────────────────────
const _b = new ArrayBuffer(8);
const _f = new Float64Array(_b);
const _u = new BigUint64Array(_b);
function ulpAdd(x, n) {
  _f[0] = x;
  _u[0] = _u[0] + BigInt(n);
  return _f[0];
}
/** IEEE-754 f64 bit pattern as 16-hex-digit string. INPUT floats travel as bits
 *  because serde_json's default float parse in this workspace is NOT correctly
 *  rounded (M2 lane finding, orchestrator-relayed 2026-07-20): a Node-exact
 *  decimal can land 1 ulp off in Rust and flip a boundary comparison. Decimal
 *  fields are kept alongside for HUMAN READABILITY ONLY — the Rust gate parses
 *  bits exclusively. */
function f64bits(x) {
  _f[0] = x;
  return _u[0].toString(16).padStart(16, '0');
}
/** Attach bit-transport twins for every load-bearing input float. */
function withBits(fx) {
  fx.wBits = f64bits(fx.w);
  fx.hBits = f64bits(fx.h);
  fx.optsBits = {
    verifyPixSigma: f64bits(fx.opts.verifyPixSigma),
    distractor: f64bits(fx.opts.distractor),
    maxMatchSigma: f64bits(fx.opts.maxMatchSigma),
    logBail: f64bits(fx.opts.logBail),
    logStop: fx.opts.logStop === null ? null : f64bits(fx.opts.logStop),
  };
  fx.refsBits = fx.refs.map((r) => r.map(f64bits));
  fx.testsBits = fx.tests.map((t) => t.map(f64bits));
  if (fx.kind === 'core') {
    fx.quadBits = {
      cx: f64bits(fx.quad.cx),
      cy: f64bits(fx.quad.cy),
      quadR2: f64bits(fx.quad.quadR2),
    };
  } else {
    fx.detABits = fx.detA.map(f64bits);
    fx.detBBits = fx.detB.map(f64bits);
  }
  return fx;
}

// ═══════════════════════ fixture builders ═══════════════════════════════════
const fixtures = [];
function core(name, { W, H }, refs, tests, quad, opts, note) {
  fixtures.push({ name, kind: 'core', w: W, h: H, opts, refs, tests, quad, ...(note ? { note } : {}) });
}

// 1 — conflict KEEP: later, farther detection loses keep-vs-switch.
{
  const sp = [[850, 150]];
  const s = baseScene(101, { nRef: 30, nMatch: 12, nDistract: 6, avoid: sp });
  s.refs.push(sp[0]); // isolated special ref, index 30
  s.tests.push([sp[0][0] + 0.4, sp[0][1], s.nextBright()]); // first claim, 0.4 px
  s.tests.push([sp[0][0] + 3.0, sp[0][1], s.nextBright()]); // later, farther => KEEP
  core('syn_conflict_keep', s, s.refs, s.tests, CENTER_QUAD, DEFAULT_OPTS());
}
// 2 — conflict SWITCH: later, much closer detection wins.
{
  const sp = [[850, 150]];
  const s = baseScene(102, { nRef: 30, nMatch: 12, nDistract: 6, avoid: sp });
  s.refs.push(sp[0]);
  s.tests.push([sp[0][0] + 4.5, sp[0][1], s.nextBright()]); // weak first claim
  s.tests.push([sp[0][0] + 0.3, sp[0][1], s.nextBright()]); // later, closer => SWITCH
  core('syn_conflict_switch', s, s.refs, s.tests, CENTER_QUAD, DEFAULT_OPTS());
}
// 3 — SWITCH with >=3 intervening distractors (retroactive re-weighting).
{
  const sp = [[850, 150]];
  const s = baseScene(103, { nRef: 30, nMatch: 10, nDistract: 2, avoid: sp });
  s.refs.push(sp[0]);
  s.tests.push([sp[0][0] + 5.0, sp[0][1], s.nextBright()]); // weak first claim
  for (let i = 0; i < 4; i++) {
    const d = distractorAt(s.rng, s.W);
    s.tests.push([d[0], d[1], s.nextBright()]); // intervening distractors
  }
  s.tests.push([sp[0][0] + 0.2, sp[0][1], s.nextBright()]); // closer => SWITCH across them
  core('syn_switch_retroactive', s, s.refs, s.tests, CENTER_QUAD, DEFAULT_OPTS());
}
// 4 — RoR cull active: small quad off-center, far refs/tests culled.
{
  const rng = mulberry32(104);
  const refs = [];
  for (let i = 0; i < 30; i++) {
    const a = rng() * 2 * Math.PI, r = rng() * 100;
    refs.push([150 + Math.cos(a) * r, 150 + Math.sin(a) * r]);
  }
  for (let i = 0; i < 15; i++) refs.push([500 + rng() * 450, 500 + rng() * 450]); // to be culled
  const tests = [];
  let bright = 500;
  for (let i = 0; i < 18; i++) {
    const r = refs[i];
    tests.push([r[0] + gauss(rng) * 1.2, r[1] + gauss(rng) * 1.2, (bright -= 2 + rng())]);
  }
  for (let i = 0; i < 10; i++) tests.push([600 + rng() * 350, 600 + rng() * 350, (bright -= 2 + rng())]);
  core('syn_ror_cull', { W: 1000, H: 1000 }, refs, tests,
    { cx: 150, cy: 150, quadR2: 100 }, DEFAULT_OPTS());
}
// 5 — partial effective-area grid (corner quad), non-default grid N.
{
  const rng = mulberry32(105);
  const refs = [];
  for (let i = 0; i < 25; i++) {
    const a = rng() * 2 * Math.PI, r = rng() * 220;
    refs.push([100 + Math.cos(a) * r, 100 + Math.sin(a) * r]);
  }
  const tests = [];
  let bright = 500;
  for (let i = 0; i < 15; i++) {
    const r = refs[i];
    tests.push([r[0] + gauss(rng) * 1.0, r[1] + gauss(rng) * 1.0, (bright -= 2 + rng())]);
  }
  for (let i = 0; i < 5; i++) tests.push([100 + rng() * 200, 380 + rng() * 40, (bright -= 2 + rng())]);
  const opts = DEFAULT_OPTS();
  opts.effAreaGridN = 8;
  core('syn_effarea_partial', { W: 1000, H: 1000 }, refs, tests,
    { cx: 100, cy: 100, quadR2: 550 }, opts);
}
// 6 — bail path: junk pose, refs left, tests right, running odds sinks past logBail.
{
  const rng = mulberry32(106);
  const refs = [];
  for (let i = 0; i < 30; i++) refs.push([60 + rng() * 240, 60 + rng() * 880]);
  const tests = [];
  let bright = 2000;
  for (let i = 0; i < 260; i++) tests.push([520 + rng() * 420, 60 + rng() * 880, (bright -= 1 + rng())]);
  core('syn_bail', { W: 1000, H: 1000 }, refs, tests, CENTER_QUAD, DEFAULT_OPTS());
}
// 7/8 — doGamma on/off pair over ONE scene: mid-radius offsets flip match/distractor.
{
  const rng = mulberry32(107);
  const refs = randRefs(rng, 30, 1000);
  const tests = [];
  let bright = 800;
  const offs = [0.5, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 18, 24, 33];
  for (let i = 0; i < offs.length; i++) {
    const r = refs[i];
    const a = rng() * 2 * Math.PI;
    tests.push([r[0] + Math.cos(a) * offs[i], r[1] + Math.sin(a) * offs[i], (bright -= 2 + rng())]);
  }
  for (let i = 0; i < 6; i++) {
    const d = distractorAt(rng, 1000);
    tests.push([d[0], d[1], (bright -= 2 + rng())]);
  }
  const quad = { cx: 500, cy: 500, quadR2: 10000 };
  const on = DEFAULT_OPTS();
  const off = DEFAULT_OPTS();
  off.doGamma = false;
  core('syn_gamma_on', { W: 1000, H: 1000 }, refs, tests, quad, on);
  core('syn_gamma_off', { W: 1000, H: 1000 }, refs, tests, quad, off);
}
// 9/10 — empties.
{
  const rng = mulberry32(108);
  const tests = [];
  for (let i = 0; i < 10; i++) tests.push([rng() * 1000, rng() * 1000, 100 - i]);
  core('syn_empty_nr0', { W: 1000, H: 1000 }, [], tests, CENTER_QUAD, DEFAULT_OPTS());
  const refs = [];
  for (let i = 0; i < 10; i++) refs.push([rng() * 1000, rng() * 1000]);
  core('syn_empty_nt0', { W: 1000, H: 1000 }, refs, [], CENTER_QUAD, DEFAULT_OPTS());
}
// 11 — effArea == 0: off-frame quad, refs/tests inside ror but every grid bin outside.
{
  const rng = mulberry32(110);
  const refs = [];
  for (let i = 0; i < 8; i++) refs.push([-600 + gauss(rng) * 60, -600 + gauss(rng) * 60]);
  const tests = [];
  for (let i = 0; i < 6; i++) tests.push([refs[i][0] + gauss(rng), refs[i][1] + gauss(rng), 50 - i]);
  core('syn_effarea_zero', { W: 1000, H: 1000 }, refs, tests,
    { cx: -600, cy: -600, quadR2: 100 }, DEFAULT_OPTS());
}
// 12 — brightness ties: ordering stability by original index, incl. an equal-bright conflict.
{
  const sp = [[850, 150]];
  const rng = mulberry32(111);
  const refs = randRefs(rng, 12, 1000, sp).concat(sp);
  const tests = [];
  for (let i = 0; i < 8; i++) {
    const r = refs[i];
    tests.push([r[0] + gauss(rng) * 0.8, r[1] + gauss(rng) * 0.8, 50.0]); // all tied
  }
  for (let i = 0; i < 3; i++) {
    const d = distractorAt(rng, 1000);
    tests.push([d[0], d[1], 50.0]); // tied distractors
  }
  tests.push([sp[0][0] + 2.0, sp[0][1], 50.0]); // tied conflict pair on the special ref:
  tests.push([sp[0][0] + 0.5, sp[0][1], 50.0]); // index order decides processing order
  tests.push([200, 900, 60.0]); // one brighter head
  tests.push([800, 930, 40.0]); // one fainter tail
  core('syn_bright_ties', { W: 1000, H: 1000 }, refs, tests, CENTER_QUAD, DEFAULT_OPTS());
}
// 13 — logfg exactly ties logd (floor boundary), ulp-scanned. Tie => match branch.
{
  const W = 1000, H = 1000;
  const D = 0.25, pix2 = 9, NR = 1;
  const logbg = Math.log(1 / (W * H));
  const logd = Math.log(D + ((1 - D) * 0) / NR) + logbg;
  const sig2 = pix2;
  const loggmax = Math.log((1 - D) / (2 * Math.PI * sig2 * NR));
  const dx0 = Math.sqrt((loggmax - logd) * (2 * sig2));
  let best = null;
  for (let n = -400; n <= 400; n++) {
    const tx = 500 + ulpAdd(dx0, n);
    const ddx = tx - 500;
    const d2 = ddx * ddx + 0 * 0;
    if (d2 > sig2 * 25) continue;
    const logfg = loggmax - d2 / (2 * sig2);
    const diff = logfg - logd;
    if (best === null || Math.abs(diff) < Math.abs(best.diff)) best = { tx, diff };
    if (diff === 0) break;
  }
  const opts = DEFAULT_OPTS();
  opts.doGamma = false;
  opts.doRoR = false;
  core('syn_tie_logfg_logd', { W, H }, [[500, 500]], [[best.tx, 500, 10]],
    { cx: 500, cy: 500, quadR2: 0 }, opts,
    `ulp-scanned tie: logfg-logd = ${best.diff} (JS side); exact tie takes the match branch`);
}
// 14 — doRoR off.
{
  const s = baseScene(113, { nRef: 35, nMatch: 18, nDistract: 8 });
  const opts = DEFAULT_OPTS();
  opts.doRoR = false;
  core('syn_ror_off', s, s.refs, s.tests, { cx: 500, cy: 500, quadR2: 40000 }, opts);
}
// 15 — early stop: finite logStop = ln(1e9), strong pose stops within a few stars.
{
  const s = baseScene(114, { nRef: 40, nMatch: 15, jitterPx: 0.7, nDistract: 5 });
  const opts = DEFAULT_OPTS();
  opts.logStop = Math.log(1e9);
  core('syn_stop_early', s, s.refs, s.tests, CENTER_QUAD, opts);
}
// 16-18 — seeded random mixed scenes with planted conflicts; varied anchors.
{
  const quads = [
    { cx: 500, cy: 500, quadR2: 250000 },
    { cx: 300, cy: 700, quadR2: 90000 },
    { cx: 800, cy: 200, quadR2: 900 }, // small => real RoR culling on a random scene
  ];
  [115, 116, 117].forEach((seed, k) => {
    const s = baseScene(seed, { nRef: 60, nMatch: 35, jitterPx: 1.5, nDistract: 20 });
    for (let i = 0; i < 3; i++) {
      const r = s.refs[i]; // second claim on already-matched refs => organic conflicts
      s.tests.push([r[0] + 2.2 + i * 0.7, r[1] - 1.1, s.nextBright()]);
    }
    core(`syn_random_${k + 1}`, s, s.refs, s.tests, quads[k], DEFAULT_OPTS());
  });
}

// ── composed-path (seed exclusion + a.net anchor) — synthetic ───────────────
function composed(name, { W, H }, refs, tests, seedRefIndices, seedTestIndices, detA, detB, opts, note) {
  fixtures.push({
    name, kind: 'composed', w: W, h: H, opts, refs, tests,
    seedRefIndices, seedTestIndices, detA, detB, ...(note ? { note } : {}),
  });
}
{
  const sp = [[200, 200], [800, 220], [210, 760], [790, 740]];
  const s = baseScene(118, { nRef: 30, nMatch: 15, nDistract: 8, avoid: sp });
  const refs = s.refs.concat(sp); // seed refs at indices 30..33
  const tests = s.tests.slice();
  const seedTests = sp.map((r, i) => [r[0] + 0.4, r[1] + 0.2, 2000 + i]);
  const base = tests.length;
  tests.push(...seedTests); // seed tests at indices base..base+3
  composed('comp_syn_1', s, refs, tests, [30, 31, 32, 33],
    [base, base + 1, base + 2, base + 3], [seedTests[0][0], seedTests[0][1]],
    [seedTests[1][0], seedTests[1][1]], DEFAULT_OPTS());
}
{
  const sp = [[180, 210], [820, 190], [190, 750], [810, 720]];
  const s = baseScene(119, { nRef: 25, nMatch: 12, nDistract: 6, avoid: sp });
  const refs = s.refs.concat(sp); // seed refs 25..28
  const tests = s.tests.slice();
  // seed tests: two anchor the quad; one sits near a NON-seed ref (removed with it —
  // that ref loses a would-be match); plus a NON-seed test near a seed ref (left in,
  // but its ref is removed => it must resolve as a distractor).
  const t0 = [sp[0][0] + 0.5, sp[0][1], 3000];
  const t1 = [sp[1][0] - 0.3, sp[1][1] + 0.4, 2999];
  const t2 = [refs[5][0] + 2.0, refs[5][1], 2998]; // near non-seed ref 5
  const t3 = [sp[2][0] + 0.7, sp[2][1] - 0.2, 2997];
  const base = tests.length;
  tests.push(t0, t1, t2, t3);
  tests.push([sp[3][0] + 1.5, sp[3][1], s.nextBright()]); // non-seed test near seed ref 28
  composed('comp_syn_2', s, refs, tests, [25, 26, 27, 28],
    [base, base + 1, base + 2, base + 3], [t0[0], t0[1]], [t1[0], t1[1]], DEFAULT_OPTS(),
    'seed test near non-seed ref + non-seed test near seed ref');
}

// ── real fixtures: CSM30799 ─────────────────────────────────────────────────
console.log('loading catalog (stars.arrow)…');
const label = JSON.parse(readFileSync(LABEL_PATH, 'utf8'));
const W = label.image_w, H = label.image_h;
const cat = loadCatalog();
console.log(`catalog rows: ${cat.n}`);
const dets = loadDetections(300);
const truthWcs = makeTan(label.ra_center_deg, label.dec_degrees, label.pixel_scale_arcsec,
  label.rotation_deg, label.parity, W, H);
const truthRefs = gatherRefs(cat, truthWcs, 300);
console.log(`truth refs in-frame: ${truthRefs.length}`);
{
  const [ai, bi] = pickAnchorPair(dets, W, H, 400, 900);
  const quad = anetQuad(dets[ai], dets[bi]);
  core('real_truth', { W, H }, truthRefs, dets, quad, DEFAULT_OPTS(),
    `truth pose ${label.ra_center_deg},${label.dec_degrees} @ ${label.pixel_scale_arcsec}"/px`);
}
// junk poses from banked clusters (last snapshot, top-voted, far from truth, mutually spread)
{
  const cj = JSON.parse(readFileSync(CLUSTERS_PATH, 'utf8'));
  const rows = cj.snapshots[cj.snapshots.length - 1].clusters;
  const chosen = [];
  for (const r of rows) {
    if (chosen.length >= 10) break;
    if (angSepDeg(r.raDeg, r.decDeg, label.ra_center_deg, label.dec_degrees) < 10) continue;
    if (chosen.some((c) => angSepDeg(r.raDeg, r.decDeg, c.raDeg, c.decDeg) < 5)) continue;
    chosen.push(r);
  }
  assert(chosen.length === 10, `junk pose selection: got ${chosen.length}`);
  const anchorSpans = [[400, 900], [200, 500], [700, 1400], [300, 700], [900, 1800]];
  chosen.forEach((r, i) => {
    // poses 0..6 at the oracle scale (wide junk); 7..9 at the cluster's own median
    // member scale (small-scale junk => deep catalog scan, denser ref field).
    let scale = label.pixel_scale_arcsec;
    if (i >= 7) {
      const ms = r.member_scales.slice().sort((a, b) => a - b);
      scale = ms[Math.floor(ms.length / 2)];
    }
    const rot = (37.0 + i * 61.7) % 360;
    const wcs = makeTan(r.raDeg, r.decDeg, scale, rot, r.parity, W, H);
    const refs = gatherRefs(cat, wcs, 300);
    if (refs.length < 10) {
      console.log(`  junk_${i}: only ${refs.length} refs in-frame — keeping anyway`);
    }
    const [ai, bi] = pickAnchorPair(dets, W, H, ...anchorSpans[i % anchorSpans.length]);
    const quad = anetQuad(dets[ai], dets[bi]);
    core(`real_junk_${String(i).padStart(2, '0')}`, { W, H }, refs, dets, quad, DEFAULT_OPTS(),
      `junk pose ${r.raDeg.toFixed(4)},${r.decDeg.toFixed(4)} par ${r.parity} scale ${scale.toFixed(3)} rot ${rot.toFixed(1)} votes ${r.votes}`);
  });
}
// composed real: truth pose with 4 matched seed pairs; junk pose with arbitrary seeds.
{
  // find 4 (ref,test) pairs, tests mutually >= 250 px apart, tolerance ladder
  let pairs = [];
  for (const tol of [3, 6, 10, 15]) {
    pairs = [];
    for (let ti = 0; ti < dets.length && pairs.length < 4; ti++) {
      let bestJ = -1, bestD = tol * tol;
      for (let rj = 0; rj < truthRefs.length; rj++) {
        const d2 = dist2(dets[ti][0], dets[ti][1], truthRefs[rj][0], truthRefs[rj][1]);
        if (d2 < bestD) { bestD = d2; bestJ = rj; }
      }
      if (bestJ === -1) continue;
      if (pairs.some((p) => dist2(dets[ti][0], dets[ti][1], dets[p.ti][0], dets[p.ti][1]) < 250 * 250)) continue;
      if (pairs.some((p) => p.rj === bestJ)) continue;
      pairs.push({ ti, rj: bestJ });
    }
    if (pairs.length === 4) break;
  }
  assert(pairs.length === 4, `comp_real_truth: only ${pairs.length} matched pairs`);
  composed('comp_real_truth', { W, H }, truthRefs, dets,
    pairs.map((p) => p.rj), pairs.map((p) => p.ti),
    [dets[pairs[0].ti][0], dets[pairs[0].ti][1]], [dets[pairs[1].ti][0], dets[pairs[1].ti][1]],
    DEFAULT_OPTS(), 'seeds = 4 nearest ref-test pairs at the truth pose');
}
{
  const junkFx = fixtures.find((f) => f.name === 'real_junk_00');
  // arbitrary (bright) seeds — exclusion semantics doesn't require true matches
  let bj = -1;
  for (let j = 1; j < dets.length; j++) {
    if (dist2(dets[0][0], dets[0][1], dets[j][0], dets[j][1]) >= 250 * 250) { bj = j; break; }
  }
  assert(bj > 0, 'comp_real_junk anchor pick');
  const st = [0, bj, bj + 1 === 2 ? 3 : bj + 1, bj + 2 === 2 ? 4 : bj + 2].slice(0, 4);
  composed('comp_real_junk', { W, H }, junkFx.refs, dets, [0, 1, 2, 3], st,
    [dets[st[0]][0], dets[st[0]][1]], [dets[st[1]][0], dets[st[1]][1]], DEFAULT_OPTS(),
    'arbitrary bright seeds on a junk pose');
}

// ═══════════════════════ run oracle + sanity + write ════════════════════════
const mod = await loadVerifyModule();
mkdirSync(OUT_DIR, { recursive: true });
const summary = [];
for (const fx of fixtures) {
  fx.expected = runFixture(mod, fx);
  const e = fx.expected;
  summary.push(
    `${fx.name.padEnd(24)} nRef=${String(e.nRef).padStart(3)} nTest=${String(e.nTest).padStart(3)} ` +
    `matched=${String(e.nMatched).padStart(3)} distr=${String(e.nDistractor).padStart(3)} ` +
    `confl=${String(e.nConflict).padStart(2)} bail=${String(e.bailedAt).padStart(3)} stop=${String(e.stoppedAt).padStart(3)} ` +
    `besti=${String(e.besti).padStart(3)} logOdds=${e.logOdds.toFixed(3)}`);
}
// intent sanity — the paths each fixture exists to exercise must actually fire
const by = (n) => fixtures.find((f) => f.name === n).expected;
assert(by('syn_conflict_keep').nConflict >= 1, 'conflict_keep has no conflict');
assert(by('syn_conflict_switch').nConflict >= 1, 'conflict_switch has no conflict');
assert(by('syn_switch_retroactive').nConflict >= 1, 'retroactive has no conflict');
assert(by('syn_switch_retroactive').nDistractor >= 3, 'retroactive lacks distractors');
assert(by('syn_ror_cull').nRef < fixtures.find((f) => f.name === 'syn_ror_cull').refs.length, 'ror_cull culled nothing');
{
  const e = by('syn_effarea_partial');
  assert(e.effArea > 0 && e.effArea < 1000 * 1000, 'effarea_partial not partial');
}
assert(by('syn_bail').bailedAt >= 0, 'bail never bailed');
assert(by('syn_empty_nr0').besti === -1 && by('syn_empty_nt0').besti === -1, 'empties not empty');
assert(by('syn_effarea_zero').effArea === 0 && by('syn_effarea_zero').besti === -1, 'effarea_zero wrong');
assert(by('syn_stop_early').stoppedAt >= 0, 'stop_early never stopped');
assert(by('syn_gamma_on').logOdds !== by('syn_gamma_off').logOdds, 'gamma pair identical');
assert(by('real_truth').nMatched >= 5, `real_truth matched only ${by('real_truth').nMatched}`);
assert(by('comp_syn_1').nRef === 30, 'comp_syn_1 filter count wrong');
for (const f of fixtures) {
  if (f.kind === 'composed') assert(f.expected.nRef <= f.refs.length - 4, `${f.name} seed refs not removed`);
}

for (const fx of fixtures) {
  writeFileSync(join(OUT_DIR, fx.name + '.json'), JSON.stringify(withBits(fx)));
}
writeFileSync(join(OUT_DIR, 'MANIFEST.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  oracle: TS_ORACLE_PATH,
  oracleExecution: 'esbuild transformSync (loader ts) from main-repo node_modules; data-URL ESM import',
  floatTransport:
    'INPUT floats carried as IEEE-754 f64 bit-pattern hex (…Bits fields) — serde_json default decimal parse is not correctly rounded (M2 finding); decimal input fields are informative only; expected outputs stay decimal (gate compares at 1e-9 rel)',
  generator: 'crates/conformance/verify_oracle/gen_fixtures.mjs',
  count: fixtures.length,
  names: fixtures.map((f) => f.name),
  realSources: { label: LABEL_PATH, detections: DET_PATH, clusters: CLUSTERS_PATH, stars: STARS_ARROW },
}, null, 2));

console.log(summary.join('\n'));
console.log(`\nwrote ${fixtures.length} fixtures + MANIFEST.json -> ${OUT_DIR}`);
