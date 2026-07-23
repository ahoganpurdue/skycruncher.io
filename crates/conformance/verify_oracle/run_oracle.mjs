// ═══════════════════════════════════════════════════════════════════════════
// M3 conformance — TS-oracle runner for the greenfield Rust verifier port.
//
// Loads the CANONICAL verifier (READ-ONLY, never edited):
//   D:/AstroLogic/worktrees/wt-quadonly/src/engine/pipeline/m6_plate_solve/quad_verify_model.ts
// by transpiling with esbuild resolved from the MAIN repo's node_modules
// (createRequire on its package.json), importing the transpiled ESM via data:
// URL — no temp files, no tsx dependency, no writes anywhere.
//
// Fixture schema (JSON, one file per case; floats round-trip bit-exact both ways):
//   { name, kind: "core"|"composed", w, h,
//     opts: { verifyPixSigma, distractor, maxMatchSigma, doGamma, doRoR,
//             effAreaGridN, logBail, logStop|null(=+Inf) },
//     refs:  [[x,y],...],  tests: [[x,y,bright],...],
//     quad:  { cx, cy, quadR2 },                             // kind=core
//     seedRefIndices: [4], seedTestIndices: [4],             // kind=composed
//     detA: [x,y], detB: [x,y],                              // kind=composed
//     expected: <full TS result field set> }
//
// For kind=composed the ORACLE side pre-filters the 4 seed refs + 4 seed tests
// (order-preserving) and computes the a.net anchor qc = midpoint(detA, detB),
// Q^2 = dist^2(qc, detA)  (verify.c:894-903 — NOT the TS quadFromPoints helper),
// then runs the core verifier on the FILTERED lists. The Rust side runs
// verify_with_seed_exclusion on the UNFILTERED lists and must match.
//
// CLI: node run_oracle.mjs <fixture.json | fixtures_dir> [--out results.json]
// ═══════════════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const MAIN_REPO_PKG =
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
export const TS_ORACLE_PATH =
  'D:/AstroLogic/worktrees/wt-quadonly/src/engine/pipeline/m6_plate_solve/quad_verify_model.ts';

let _mod = null;

/** Transpile + import the TS oracle module (cached). */
export async function loadVerifyModule() {
  if (_mod) return _mod;
  const require2 = createRequire(MAIN_REPO_PKG);
  const esbuild = require2('esbuild');
  const src = readFileSync(TS_ORACLE_PATH, 'utf8');
  const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'esm' });
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  _mod = await import('data:text/javascript;base64,' + b64);
  if (typeof _mod.computeQuadVerifyModel !== 'function') {
    throw new Error('oracle load failed: computeQuadVerifyModel missing');
  }
  return _mod;
}

// f64 bit-pattern decode (…Bits fields are the authoritative input floats; the decimal
// twins are informative only — see gen_fixtures.mjs `withBits` for why).
const _bb = new ArrayBuffer(8);
const _bf = new Float64Array(_bb);
const _bu = new BigUint64Array(_bb);
function fromBits(hex) {
  _bu[0] = BigInt('0x' + hex);
  return _bf[0];
}

export function decodeOpts(o, bits) {
  return {
    verifyPixSigma: bits ? fromBits(bits.verifyPixSigma) : o.verifyPixSigma,
    distractor: bits ? fromBits(bits.distractor) : o.distractor,
    maxMatchSigma: bits ? fromBits(bits.maxMatchSigma) : o.maxMatchSigma,
    doGamma: o.doGamma,
    doRoR: o.doRoR,
    effAreaGridN: o.effAreaGridN,
    logBail: bits ? fromBits(bits.logBail) : o.logBail,
    logStop: (bits ? bits.logStop : o.logStop) === null
      ? Number.POSITIVE_INFINITY
      : bits ? fromBits(bits.logStop) : o.logStop,
  };
}

/** Authoritative input views: bits fields when present, decimals otherwise
 *  (in-memory fixtures during generation carry the original f64s directly). */
function inputViews(fx) {
  const refs = fx.refsBits ? fx.refsBits.map((r) => r.map(fromBits)) : fx.refs;
  const tests = fx.testsBits ? fx.testsBits.map((t) => t.map(fromBits)) : fx.tests;
  const w = fx.wBits ? fromBits(fx.wBits) : fx.w;
  const h = fx.hBits ? fromBits(fx.hBits) : fx.h;
  const quad = fx.quadBits
    ? { cx: fromBits(fx.quadBits.cx), cy: fromBits(fx.quadBits.cy), quadR2: fromBits(fx.quadBits.quadR2) }
    : fx.quad;
  const detA = fx.detABits ? fx.detABits.map(fromBits) : fx.detA;
  const detB = fx.detBBits ? fx.detBBits.map(fromBits) : fx.detB;
  return { refs, tests, w, h, quad, detA, detB };
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

/** Seed-exclusion normalization — the SAME rule the Rust wrapper implements. */
export function composeFilter(refsIn, testsIn, sr, st, detA, detB) {
  const refs = refsIn.filter((_, i) => !sr.includes(i));
  const tests = testsIn.filter((_, i) => !st.includes(i));
  const [ax, ay] = detA;
  const [bx, by] = detB;
  const qcx = (ax + bx) / 2;
  const qcy = (ay + by) / 2;
  const quadR2 = dist2(qcx, qcy, ax, ay);
  return { refs, tests, quad: { cx: qcx, cy: qcy, quadR2 } };
}

/** Run the oracle on one fixture object; returns the raw TS result. */
export function runFixture(mod, fx) {
  const iv = inputViews(fx);
  const opts = decodeOpts(fx.opts, fx.optsBits);
  let refsArr = iv.refs, testsArr = iv.tests, quad = iv.quad;
  if (fx.kind === 'composed') {
    const f = composeFilter(iv.refs, iv.tests, fx.seedRefIndices, fx.seedTestIndices, iv.detA, iv.detB);
    refsArr = f.refs;
    testsArr = f.tests;
    quad = f.quad;
  }
  const refs = refsArr.map(([x, y]) => ({ x, y }));
  const tests = testsArr.map(([x, y, bright]) => ({ x, y, bright }));
  return mod.computeQuadVerifyModel(refs, tests, iv.w, iv.h, quad, opts);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const target = args.filter((a, i) => outIdx < 0 || (i !== outIdx && i !== outIdx + 1))[0];
  if (!target) {
    console.error('usage: node run_oracle.mjs <fixture.json|dir> [--out results.json]');
    process.exit(2);
  }
  const files = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json')
        .sort()
        .map((f) => join(target, f))
    : [target];
  const mod = await loadVerifyModule();
  const out = {};
  for (const f of files) {
    const fx = JSON.parse(readFileSync(f, 'utf8'));
    out[fx.name] = runFixture(mod, fx);
  }
  const json = JSON.stringify(out, null, 2);
  if (outPath) writeFileSync(outPath, json);
  else console.log(json);
}
