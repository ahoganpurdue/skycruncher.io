// Fixture test for the deterministic render-layer denoise lane
// (tools/denoise/denoise.mjs). Proves the ONE thing that matters:
// noise-floor reduction WITHOUT flux bias — the honest-integrity gate that
// separates measurement-grade processing from the aesthetic XTerminators.
//
// (a) background MAD σ drops after denoise (noise reduced)
// (b) total aperture flux over the brightest sources is preserved (|1−ratio|<0.02)
// (c) VST forward→EXACT-UNBIASED inverse round-trips a synthetic Poisson–Gaussian
//     flat field, and the exact inverse beats the NAIVE inverse at low counts
//     (the Mäkitalo–Foi trap the doc warns about).
//
// The engine-side integrity gate for a shipped op is the existing forced-
// photometry machinery (m6_plate_solve/deep_verify.ts + forced_confirm.ts) run
// pre/post; this lane is a tools/ prototype and does NOT wire into it — the
// aperture-flux check here is the standalone prototype-lane equivalent.
//
// The fixture is a real SeeStar M66 stack from the LOCAL, gitignored corpus, so
// the corpus-dependent block SKIPS gracefully when the file is absent (keeps
// `npx vitest run` green in a clean clone); the synthetic VST round-trip always
// runs. .mjs core + hand-written .d.mts keeps the tsc gate at baseline.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import {
  denoiseImage,
  estimateNoiseModel,
  backgroundMadSigma,
  detectTopSources,
  apertureFluxSum,
  cropPlane,
  loadFitsPlane,
  gat,
  inverseGatExact,
  naiveInverseGat,
} from '../../../tools/denoise/denoise.mjs';

// SeeStar M66 stack (2160×3840×3, referenced by test_results/corpus_manifest.json).
const FIXTURE = 'Sample Files/archive/DSO_Stacked_738_M66_DUPLICATE_of_truth_anchor.fit';
const HAVE_FIXTURE = fs.existsSync(FIXTURE);

// ── (a)+(b) real-frame integrity: noise down, flux preserved ──────────────────
describe.skipIf(!HAVE_FIXTURE)('denoise on a real SeeStar frame — noise floor down, flux preserved', () => {
  // central 1024×1024 crop of the green plane (background + stars + galaxy).
  // Setup lives in beforeAll so a skipped describe (absent corpus) never
  // touches the fixture — the describe BODY runs at collection time even
  // when skipIf is true, and loadFitsPlane(null-fixture) used to throw here.
  const CW = 1024, CH = 1024;
  let crop!: ReturnType<typeof cropPlane>, model!: ReturnType<typeof estimateNoiseModel>;
  let output!: ReturnType<typeof denoiseImage>['output'], receipt!: ReturnType<typeof denoiseImage>['receipt'];
  beforeAll(() => {
    const { plane, W, H } = loadFitsPlane(FIXTURE, 1)!;
    crop = cropPlane(plane, W, H, (W - CW) >> 1, (H - CH) >> 1, CW, CH);
    model = estimateNoiseModel(crop, CW, CH);
    ({ output, receipt } = denoiseImage(crop, CW, CH, { kappa: 3, noiseModel: model }));
  });

  it('estimates a Poisson–Gaussian model and labels it honestly', () => {
    expect(model.source).toBe('ESTIMATED');       // ZWO "GAIN" is a register, not e⁻/ADU
    expect(model.approximate).toBe(true);         // → APPROXIMATE, never a bare number
    expect(model.alpha).toBeGreaterThan(0);
    expect(model.gain_e_per_adu).toBeGreaterThan(0);
    expect(receipt.noise_model.label).toBe('APPROXIMATE');
  });

  it('produces a correctly-scaled VST (MAD in VST domain ≈ 1)', () => {
    // if α/σ are right, the stabilized noise is unit-variance — a built-in health check.
    expect(receipt.mad_sigma_vst_domain!).toBeGreaterThan(0.7);
    expect(receipt.mad_sigma_vst_domain!).toBeLessThan(1.4);
  });

  it('(a) reduces the background noise floor', () => {
    const pre = backgroundMadSigma(crop, CW, CH);
    const post = backgroundMadSigma(output, CW, CH);
    // report both; post must be strictly (and here, substantially) below pre.
    expect(post).toBeLessThan(pre);
    expect(post).toBeLessThan(0.5 * pre);
    expect(pre).toBeGreaterThan(0);
  });

  it('(b) preserves total flux over the brightest sources (|1−ratio| < 0.02)', () => {
    const sources = detectTopSources(crop, CW, CH, 30);
    expect(sources.length).toBeGreaterThan(10);
    const before = apertureFluxSum(crop, CW, CH, sources, 4);
    const after = apertureFluxSum(output, CW, CH, sources, 4);
    const ratio = after / before;
    expect(before).toBeGreaterThan(0);
    expect(Math.abs(1 - ratio)).toBeLessThan(0.02);
  });
});

if (!HAVE_FIXTURE) {
  // eslint-disable-next-line no-console
  console.warn(`[denoise.test] corpus fixture absent (${FIXTURE}) — real-frame asserts skipped (local-only corpus).`);
}

// ── (c) VST round-trip: exact-unbiased inverse vs the naive-inverse trap ───────
describe('VST round-trip — exact-unbiased inverse (Mäkitalo–Foi) beats the naive inverse', () => {
  // deterministic PRNG + Poisson/Gaussian samplers (seeded → reproducible).
  function mulberry32(a: number) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260707);
  function gauss(): number {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function poisson(l: number): number {
    if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * gauss()));
    const Lp = Math.exp(-l);
    let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > Lp);
    return k - 1;
  }
  // ideal-denoise a flat field of intensity m: average GAT over N noisy pixels,
  // then invert. The exact unbiased inverse recovers m; the naive one biases low.
  function flatField(m: number, gain: number, rn: number, N: number) {
    const alpha = 1 / gain, sigma = rn;
    let sumGat = 0;
    for (let i = 0; i < N; i++) {
      const e = poisson(gain * m);
      const y = e / gain + rn * gauss();
      sumGat += gat(y, alpha, sigma);
    }
    const Dbar = sumGat / N;
    return { exact: inverseGatExact(Dbar, alpha, sigma), naive: naiveInverseGat(Dbar, alpha, sigma) };
  }

  it('(c) exact inverse round-trips a moderate-count flat field within 0.5%', () => {
    const m = 50, r = flatField(m, 2.0, 3.0, 200000);
    expect(Math.abs(r.exact - m) / m).toBeLessThan(0.005);
  });

  it('exact inverse is unbiased across the count range where naive is not', () => {
    for (const m of [100, 20, 10]) {
      const r = flatField(m, 2.0, 3.0, 200000);
      expect(Math.abs(r.exact - m) / m).toBeLessThan(0.01);
    }
  });

  it('at low counts the naive inverse biases low — exact is strictly better (the trap)', () => {
    const m = 5, r = flatField(m, 2.0, 3.0, 200000);
    const exactErr = Math.abs(r.exact - m) / m;
    const naiveErr = Math.abs(r.naive - m) / m;
    expect(naiveErr).toBeGreaterThan(0.015);   // naive is visibly biased
    expect(exactErr).toBeLessThan(naiveErr);   // exact removes that bias
    expect(r.naive).toBeLessThan(m);           // and the bias is downward, as documented
  });
});
