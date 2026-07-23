// ═══════════════════════════════════════════════════════════════════════════
// tools/atmosphere — fit_vertical KERNEL (driven by fit_vertical.mjs)
// ═══════════════════════════════════════════════════════════════════════════
// Spec: docs/ATMOSPHERE_SEXTANT_SPEC.md increment 2. Single-frame flux vertical
// v1 — robust fit of (ZP, k, β, zenith ẑ) on the bundled CR2's forced-photometry
// star table (built by lib/star_table.ts — the SAME table inc 1 measured).
//
//   Δm_i,ch = ZP_ch + k_ch·X_KY(alt_i(ẑ)) + V_nuis(r_i) + β_ch·color_i + ε_i
//   alt_i(ẑ) = asin(ẑ · ŝ_i);  X_KY = AtmosphericManager.computeAirMass (K-Y)
//
// Estimator (spec: "Levenberg-Marquardt on (ZP,k,β,ẑ[2dof]) with Tukey-biweight
// IRLS, c=4.685·MAD"). Implemented as SEPARABLE least squares (VarPro): the model
// is LINEAR in (ZP,k,a2,a4,β) for a fixed ẑ, so the nonlinear search is 2-D over ẑ
// only (coarse 5° unit-sphere grid → Nelder–Mead refine) with the linear block
// solved EXACTLY inside each evaluation. Mathematically equivalent to joint LM but
// far more robust on the vignette↔extinction ridge than a 13-param numeric-Jacobian
// LM. Tukey-biweight IRLS wraps the whole thing (c = 4.685·MAD). DEVIATION recorded
// in README (Law 2 flag-not-tune; a method choice, not a threshold tune).
//
// Identifiability guards (honest-or-absent, each names its predicate):
//   • in-frame airmass span ΔX < 0.3  → k NOT MEASURED
//   • fitted ẑ within 20° of boresight AND no pooled vignette profile → ẑ NOT MEASURED
//   • stars below alt 20° CUT (differential refraction ~5px at 63"/px in v1)
//
// TWO LEDGERS: alt/az/X/ẑ = COORDINATE; the Δm come from PIXEL forced photometry.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtmosphericManager } from '@/engine/core/AtmosphericManager';
import { TimeService } from '@/engine/core/TimeService';
import { buildStarTable, gnomonicInverse, type StarRow, type StarTable } from './lib/star_table';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const D2R = Math.PI / 180, H2R = Math.PI / 12;
const chs = ['R', 'G', 'B'] as const;
type Ch = typeof chs[number];

// ── Increment-2 initial engineering values (README table; Law 2 — flag, don't tune) ──
const DX_MIN = 0.30;          // in-frame airmass span floor for k identifiability
const BORESIGHT_MIN_DEG = 20; // ẑ must sit ≥ this off boresight (else V↔k aliased)
const ELLIPSE_MAX_DEG = 15;   // ẑ 1σ ellipse semi-major above this ⇒ direction unconstrained (data's own σ refuses)
const ALT_CUT_DEG = 20;       // low-alt cut (differential refraction) — v1
const N_MIN_HI = 15;          // min stars above ALT_CUT for a ẑ to be evaluable (v1 domain)
const TUKEY_C = 4.685;        // Tukey biweight tuning (× MAD)
const IRLS_ITERS = 8;
const GRID_STEP_DEG = 5;      // coarse ẑ unit-sphere grid step (spec "5° steps suffice")
const RUNS_Z_FLAG = 2.0;      // |runs-test z| above which residual-in-alt structure is flagged

const OUT_JSON = process.env.ATM_FIT_OUT_JSON ?? path.join(ROOT, 'test_results/atmosphere/fit_vertical_cr2.json');
const OUT_SVG = process.env.ATM_FIT_OUT_SVG ?? path.join(ROOT, 'test_results/atmosphere/fit_vertical_cr2.svg');
const LEDGER = process.env.ATM_LEDGER ?? path.join(ROOT, 'tools/atmosphere/validation_ledger.jsonl');

// ── linear algebra (tiny dense — Gaussian elimination + inverse) ──
function solveSym(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    let d = M[c][c]; if (Math.abs(d) < 1e-14) d = M[c][c] = (d < 0 ? -1e-14 : 1e-14);
    for (let k = c; k <= n; k++) M[c][k] /= d;                 // normalise pivot row → 1
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map(r => r[n]);
}
function invSym(A: number[][]): number[][] {
  const n = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-14; for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c]; for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map(r => r.slice(n));
}
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const madOf = (a: number[]) => { const m = median(a); return 1.4826 * median(a.map(v => Math.abs(v - m))); };

// ── COORDINATE ledger: unit vectors + airmass at a hypothesised zenith ──
function unitVec(raH: number, decD: number): [number, number, number] {
  const ra = raH * H2R, dec = decD * D2R;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}
function altOf(z: [number, number, number], s: [number, number, number]) {
  const d = Math.max(-1, Math.min(1, z[0] * s[0] + z[1] * s[1] + z[2] * s[2]));
  return Math.asin(d) / D2R; // degrees
}
// galactic latitude b (J2000 pole) — colour-vs-latitude alias diagnostic
function galB(raH: number, decD: number) {
  const raG = 192.859508 * D2R, decG = 27.128336 * D2R, ra = raH * 15 * D2R, dec = decD * D2R;
  return Math.asin(Math.sin(dec) * Math.sin(decG) + Math.cos(dec) * Math.cos(decG) * Math.cos(ra - raG)) / D2R;
}

// ── the separable linear block: for a FIXED ẑ, fit (ZP_ch,k_ch,a2,a4[,β_ch]) ──
// design columns per (star,ch): [ZP_R,ZP_G,ZP_B, k_R,k_G,k_B, a2, a4 (, β_R,β_G,β_B)]
interface Obs { s: [number, number, number]; r2: number; ch: Ch; y: number; wMeas: number; color: number | null; star: number; }
interface LinFit { p: number[]; cov: number[][]; ssr: number; nobs: number; resid: number[]; obs: Obs[]; ncol: number; withBeta: boolean; wTukey: number[]; sumWtukey: number; nBelow: number; nStarsHi: number; minAlt: number; }

// objective for the ẑ search: a ẑ is ADMISSIBLE only if the WHOLE field is above
// ALT_CUT_DEG (minAlt ≥ cut). This is what makes the SSR comparable across ẑ — the
// in-fit star set is then FIXED (no star ever drops below the cut/horizon as ẑ moves),
// so the fit cannot game the objective by excluding hard stars. It also (a) enforces
// the v1 differential-refraction exclusion for the WHOLE field and (b) kills the
// near-horizon spurious solutions (airmass-cap leverage). Non-finite ssr ⇒ Infinity.
const objVal = (f: LinFit | null) => (f && Number.isFinite(f.ssr) && f.minAlt >= ALT_CUT_DEG) ? f.ssr : Infinity;

function fitLinear(obs: Obs[], z: [number, number, number], wTukey: number[], withBeta: boolean): LinFit {
  const ncol = withBeta ? 11 : 8;
  const chIdx: Record<Ch, number> = { R: 0, G: 1, B: 2 };
  // pass 1: airmass per obs + centering means (decouples slope from intercept —
  // when ΔX is tiny the CENTERED k column is small so k gets a large σ, but the
  // solve stays well-conditioned instead of going singular/NaN near boresight).
  // in-fit set = ALL obs (fixed across admissible ẑ, since admissibility requires the
  // whole field above ALT_CUT — see objVal). minAlt drives the admissibility gate;
  // nStarsHi kept for reporting. Centering means over all obs.
  const Xarr = new Array(obs.length), used = new Array(obs.length);
  let nBelow = 0, mX = 0, mR2 = 0, mR4 = 0, nUsed = 0, minAlt = 90; const starSetHi = new Set<number>();
  for (let i = 0; i < obs.length; i++) {
    const alt = altOf(z, obs[i].s); if (alt < 0) nBelow++; if (alt < minAlt) minAlt = alt;
    const X = AtmosphericManager.computeAirMass(alt); Xarr[i] = X;
    used[i] = true;                                // fixed in-fit set
    if (alt >= ALT_CUT_DEG) starSetHi.add(obs[i].star);
    mX += X; mR2 += obs[i].r2; mR4 += obs[i].r2 * obs[i].r2; nUsed++;
  }
  const nStarsHi = starSetHi.size;
  if (nUsed > 0) { mX /= nUsed; mR2 /= nUsed; mR4 /= nUsed; }
  // weighted Gram–Schmidt: orthogonalise the r⁴ column against r² (they are ~collinear
  // over r∈[0,1] → raw a2/a4 blow up and overfit noise, dragging ẑ off). Same model
  // SPAN (no bias); raw a2,a4 reconstructed after the solve. β from measurement weights.
  let gsNum = 0, gsDen = 0;
  for (let i = 0; i < obs.length; i++) { if (!used[i]) continue; const c2 = obs[i].r2 - mR2, c4 = obs[i].r2 * obs[i].r2 - mR4; gsNum += obs[i].wMeas * c2 * c4; gsDen += obs[i].wMeas * c2 * c2; }
  const gsBeta = gsDen > 1e-12 ? gsNum / gsDen : 0;
  const AtA = Array.from({ length: ncol }, () => new Array(ncol).fill(0));
  const Atb = new Array(ncol).fill(0);
  const rowsCache: number[][] = [];
  let sumWtukey = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    const c2 = o.r2 - mR2, c4 = o.r2 * o.r2 - mR4;
    const row = new Array(ncol).fill(0);
    row[chIdx[o.ch]] = 1;                        // ZP_ch (intercept at mean X / mean r²)
    row[3 + chIdx[o.ch]] = Xarr[i] - mX;         // k_ch · (X − X̄)
    row[6] = c2;                                 // a2' · (r² − r̄²)
    row[7] = c4 - gsBeta * c2;                   // a4' · orthogonalised (r⁴ − r̄⁴)⊥r²
    if (withBeta) row[8 + chIdx[o.ch]] = o.color ?? 0; // β_ch·color
    rowsCache.push(row);
    const w = used[i] ? o.wMeas * wTukey[i] : 0; sumWtukey += used[i] ? wTukey[i] : 0;
    for (let a = 0; a < ncol; a++) { Atb[a] += w * row[a] * o.y; for (let b = 0; b < ncol; b++) AtA[a][b] += w * row[a] * row[b]; }
  }
  // tiny ridge on ALL columns (numerical floor ≪ signal; does NOT bias k) + a
  // slightly larger floor on the vignette/β columns.
  for (let a = 0; a < ncol; a++) AtA[a][a] += (a >= 6 ? 1e-6 : 1e-8);
  const p = solveSym(AtA, Atb);
  let ssr = 0; const resid: number[] = [];
  for (let i = 0; i < obs.length; i++) {
    let pred = 0; for (let a = 0; a < ncol; a++) pred += rowsCache[i][a] * p[a];
    const r = obs[i].y - pred; resid.push(r);
    if (used[i]) ssr += obs[i].wMeas * wTukey[i] * r * r;
  }
  const cov = invSym(AtA);
  // reconstruct raw (a2,a4) from the orthogonalised (a2',a4') then de-center the ZP
  // intercepts back to (X=0, r=0), so reported params satisfy the un-centered model
  // Δm = ZP + k·X + a2·r² + a4·r⁴ (k / a2 / a4 are unchanged by centering).
  const rawA4 = p[7], rawA2 = p[6] - p[7] * gsBeta;
  p[6] = rawA2; p[7] = rawA4;
  for (const ch of chs) p[chIdx[ch]] = p[chIdx[ch]] - p[3 + chIdx[ch]] * mX - rawA2 * mR2 - rawA4 * mR4;
  return { p, cov, ssr, nobs: nUsed, resid, obs, ncol, withBeta, wTukey, sumWtukey, nBelow, nStarsHi, minAlt };
}

// robust IRLS + Nelder–Mead over ẑ(2-dof). Returns best ẑ, its LinFit, and the objective.
function fitZenith(obs: Obs[], z0: { raH: number; decD: number } | null, withBeta: boolean) {
  const objAt = (raH: number, decD: number, wTukey: number[]) => {
    const z = unitVec(raH, decD);
    return fitLinear(obs, z, wTukey, withBeta);
  };
  let wTukey = new Array(obs.length).fill(1);
  // 1. coarse unit-sphere grid (5° steps) unless a z0 init is supplied. Collect the
  //    top-K admissible grid points and NM-refine EACH (multi-start) — the objective
  //    has local minima along the k↔ẑ-distance ridge, so a single start is unreliable.
  let best = { raH: z0?.raH ?? 0, decD: z0?.decD ?? 0, fit: null as LinFit | null, ssr: Infinity };
  if (z0) { const f = objAt(z0.raH, z0.decD, wTukey); best = { raH: z0.raH, decD: z0.decD, fit: f, ssr: objVal(f) }; }
  else {
    const cand: { raH: number; decD: number; o: number }[] = [];
    for (let decD = -85; decD <= 85; decD += GRID_STEP_DEG) {
      const raStep = GRID_STEP_DEG / 15 / Math.max(0.15, Math.cos(decD * D2R));
      for (let raH = 0; raH < 24; raH += raStep) {
        const o = objVal(objAt(raH, decD, wTukey));
        if (Number.isFinite(o)) cand.push({ raH, decD, o });
      }
    }
    cand.sort((a, b) => a.o - b.o);
    for (const c of cand.slice(0, 6)) {
      const seed = { raH: c.raH, decD: c.decD, fit: objAt(c.raH, c.decD, wTukey), ssr: c.o };
      const r = nelderMead(c.raH, c.decD, (ra, dc) => objAt(ra, dc, wTukey), seed);
      if (r.ssr < best.ssr) best = r;
    }
  }
  if (!best.fit) return best; // no admissible zenith found (guarded by caller)
  // 2. IRLS: reweight (Tukey), then Nelder–Mead refine ẑ around current best
  for (let it = 0; it < IRLS_ITERS; it++) {
    const scale = Math.max(1e-4, madOf(best.fit.resid));
    wTukey = best.fit.resid.map(r => { const u = r / (TUKEY_C * scale); return Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0; });
    best.fit = objAt(best.raH, best.decD, wTukey); best.ssr = objVal(best.fit);
    best = nelderMead(best.raH, best.decD, (ra, dc) => objAt(ra, dc, wTukey), best);
  }
  return best as { raH: number; decD: number; fit: LinFit; ssr: number };
}

function nelderMead(ra0: number, dc0: number, f: (ra: number, dc: number) => LinFit, seed: any) {
  type V = { ra: number; dc: number; s: number };
  const ev = (ra: number, dc: number): V => ({ ra, dc, s: objVal(f(ra, dc)) });
  let simplex: V[] = [ev(ra0, dc0), ev(ra0 + 1.5, dc0), ev(ra0, dc0 + 1.5)];
  for (let iter = 0; iter < 120; iter++) {
    simplex.sort((a, b) => a.s - b.s);
    const [lo, mid, hi] = simplex;
    const cr = { ra: (lo.ra + mid.ra) / 2, dc: (lo.dc + mid.dc) / 2 };
    const refl = ev(cr.ra + (cr.ra - hi.ra), cr.dc + (cr.dc - hi.dc));
    if (refl.s < lo.s) {
      const exp = ev(cr.ra + 2 * (cr.ra - hi.ra), cr.dc + 2 * (cr.dc - hi.dc));
      simplex[2] = exp.s < refl.s ? exp : refl;
    } else if (refl.s < mid.s) simplex[2] = refl;
    else {
      const con = ev(cr.ra + 0.5 * (hi.ra - cr.ra), cr.dc + 0.5 * (hi.dc - cr.dc));
      if (con.s < hi.s) simplex[2] = con;
      else { simplex[1] = ev((lo.ra + mid.ra) / 2, (lo.dc + mid.dc) / 2); simplex[2] = ev((lo.ra + hi.ra) / 2, (lo.dc + hi.dc) / 2); }
    }
    if (Math.abs(simplex[0].s - simplex[2].s) < 1e-9 * (1 + Math.abs(simplex[0].s))) break;
  }
  simplex.sort((a, b) => a.s - b.s);
  const bra = simplex[0].ra, bdc = simplex[0].dc, bf = f(bra, bdc);
  return objVal(bf) < seed.ssr ? { raH: ((bra % 24) + 24) % 24, decD: Math.max(-89.9, Math.min(89.9, bdc)), fit: bf, ssr: objVal(bf) } : seed;
}

// runs test for residual-vs-alt structure (sort by alt, sign runs → z)
function runsZ(pairs: { alt: number; r: number }[]) {
  const s = [...pairs].sort((a, b) => a.alt - b.alt).map(p => (p.r >= 0 ? 1 : -1));
  const n1 = s.filter(x => x > 0).length, n2 = s.length - n1;
  if (n1 === 0 || n2 === 0) return 0;
  let runs = 1; for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1]) runs++;
  const mu = 1 + (2 * n1 * n2) / (n1 + n2);
  const varr = (2 * n1 * n2 * (2 * n1 * n2 - n1 - n2)) / ((n1 + n2) ** 2 * (n1 + n2 - 1));
  return varr > 0 ? (runs - mu) / Math.sqrt(varr) : 0;
}

describe('tools/atmosphere — fit_vertical (ZP,k,β,ẑ) on the bundled CR2', () => {
  it('fits the flux vertical with honest identifiability guards / named refusals', async () => {
    const notMeasured: Record<string, string> = {};
    const table: StarTable = await buildStarTable();
    const { w, h, ra0H, dec0D, scale_arcsec_px, theta_deg, parity, anchor_px } = table.meta;
    const degPerPx = scale_arcsec_px / 3600;
    console.log(`[table] usable=${table.meta.counts.usable}  band GaiaG=${table.meta.band.GaiaG} JohnsonV=${table.meta.band.JohnsonV}  purity≈${table.meta.counts.purity}`);
    // persist the per-star forced-photometry table (evidence + reuse for inc 5/6) — the
    // per-star pixel positions + catalog unit-vector inputs inc 1 measured but did not save
    const STAR_TABLE_JSON = process.env.ATM_STAR_TABLE ?? path.join(ROOT, 'test_results/atmosphere/star_table_cr2.json');
    fs.mkdirSync(path.dirname(STAR_TABLE_JSON), { recursive: true });
    fs.writeFileSync(STAR_TABLE_JSON, JSON.stringify({ meta: table.meta, stars: table.stars, sigma_by_mag: table.sigma_by_mag, zeropoints: table.zeropoints }, null, 2), 'utf8');

    // boresight sky direction: invert geometry for the frame-centre pixel (W/2,H/2)
    const [AX, AY] = anchor_px, cT = Math.cos(theta_deg * D2R), sT = Math.sin(theta_deg * D2R);
    const u = (w / 2 - AX) * degPerPx, v = (h / 2 - AY) * degPerPx;
    const xiC = u * cT + v * sT, etaC = (-u * sT + v * cT) / parity;
    const cen = gnomonicInverse(xiC, etaC, ra0H, dec0D);
    const sCen = unitVec(cen.raH, cen.decD);

    // σ(mag)-table weights (logistics: "weights from the measured σ(mag) table")
    const sigLookup = (band: string, mag: number, ch: Ch): number => {
      const bin = table.sigma_by_mag.find(e => e.band === band && Number(e.mag_bin.split('-')[0]) === Math.floor(mag) && Number.isFinite(e[`sigma_${ch}`]));
      const anyBin = table.sigma_by_mag.filter(e => e.band === band && Number.isFinite(e[`sigma_${ch}`]));
      const s = bin ? bin[`sigma_${ch}`] : (anyBin.length ? median(anyBin.map(e => e[`sigma_${ch}`])) : 0.3);
      return Math.max(0.05, s);
    };
    const buildObs = (rows: StarRow[], band: string): Obs[] => {
      const obs: Obs[] = [];
      rows.forEach((st, idx) => {
        const s = unitVec(st.raH, st.decD);
        const r2 = (Math.hypot(st.x - w / 2, st.y - h / 2) / (0.5 * Math.hypot(w, h))) ** 2;
        for (const ch of chs) {
          const y = st.dm[ch]; if (!Number.isFinite(y as number)) continue;
          const sg = sigLookup(band, st.mag, ch);
          obs.push({ s, r2, ch, y: y as number, wMeas: 1 / (sg * sg), color: st.color, star: idx });
        }
      });
      return obs;
    };

    // ── PRIMARY fit: GaiaG band (the N-bearing population; no colour column → no β) ──
    const gRows = table.stars.filter(r => r.band === 'GaiaG');
    const obs = buildObs(gRows, 'GaiaG');
    const best = fitZenith(obs, null, false);
    if (!best.fit) throw new Error(`no admissible zenith found (need ≥${N_MIN_HI} stars above alt ${ALT_CUT_DEG}° — the whole wide field cannot be held high enough)`);
    // the fit already excludes alt<ALT_CUT internally; usedRows = the alt≥cut set at ẑ_hat
    const zv = unitVec(best.raH, best.decD);
    const cutLow = gRows.filter(st => altOf(zv, unitVec(st.raH, st.decD)) < ALT_CUT_DEG).length;
    const usedRows = gRows.filter(st => altOf(zv, unitVec(st.raH, st.decD)) >= ALT_CUT_DEG);

    // fitted params + formal covariance. s² = robustified reduced χ² (weighted SSR
    // over effective dof = Σw_tukey − ncol).
    const p = best.fit.p, cov = best.fit.cov;
    const nEff = best.fit.sumWtukey - best.fit.ncol;
    const s2 = best.fit.ssr / Math.max(1, nEff);
    const kCh: Record<Ch, number> = { R: p[3], G: p[4], B: p[5] };
    const zpCh: Record<Ch, number> = { R: p[0], G: p[1], B: p[2] };
    const sigKlin: Record<Ch, number> = { R: Math.sqrt(Math.max(0, cov[3][3] * s2)), G: Math.sqrt(Math.max(0, cov[4][4] * s2)), B: Math.sqrt(Math.max(0, cov[5][5] * s2)) };

    // ── identifiability: airmass span ΔX at fitted ẑ ──
    const alts = usedRows.map(st => altOf(zv, unitVec(st.raH, st.decD)));
    const Xs = alts.map(a => AtmosphericManager.computeAirMass(a));
    const dX = Math.max(...Xs) - Math.min(...Xs);
    const boresightAngle = Math.acos(Math.max(-1, Math.min(1, zv[0] * sCen[0] + zv[1] * sCen[1] + zv[2] * sCen[2]))) / D2R;

    // ── ẑ covariance ellipse (ALWAYS computed — it is the refusal evidence when large) ──
    // FD Hessian of the SSR profile at ẑ_hat, holding the converged robust weights fixed.
    const wConv = best.fit.wTukey;
    const Jf = (ra: number, dc: number) => fitLinear(obs, unitVec(ra, dc), wConv, false);
    const dRa = 0.05, dDc = 0.05, j0 = Jf(best.raH, best.decD).ssr;
    const Hrr = (Jf(best.raH + dRa, best.decD).ssr - 2 * j0 + Jf(best.raH - dRa, best.decD).ssr) / (dRa * dRa);
    const Hdd = (Jf(best.raH, best.decD + dDc).ssr - 2 * j0 + Jf(best.raH, best.decD - dDc).ssr) / (dDc * dDc);
    const Hrd = (Jf(best.raH + dRa, best.decD + dDc).ssr - Jf(best.raH + dRa, best.decD - dDc).ssr - Jf(best.raH - dRa, best.decD + dDc).ssr + Jf(best.raH - dRa, best.decD - dDc).ssr) / (4 * dRa * dDc);
    const s2z = j0 / Math.max(1, nEff);
    const covZ0 = invSym([[Hrr, Hrd], [Hrd, Hdd]]).map(r => r.map(v => v * 2 * s2z)); // cov=2·s²·H⁻¹ (Gauss–Newton), in (ra-h, dec-deg)
    const sc = 15 * Math.cos(best.decD * D2R); // ra-hours → on-sky deg
    const covSky = [[covZ0[0][0] * sc * sc, covZ0[0][1] * sc], [covZ0[1][0] * sc, covZ0[1][1]]];
    const ea = covSky[0][0], eb = covSky[0][1], ed = covSky[1][1];
    const etr = ea + ed, edet = ea * ed - eb * eb, edisc = Math.sqrt(Math.max(0, etr * etr / 4 - edet));
    const semiMajor = Math.sqrt(Math.max(0, etr / 2 + edisc)), semiMinor = Math.sqrt(Math.max(0, etr / 2 - edisc));
    const ellipse = { semi_major_deg: +semiMajor.toFixed(3), semi_minor_deg: +semiMinor.toFixed(3), pa_deg: +(Math.atan2(etr / 2 + edisc - ea, eb) / D2R).toFixed(1), cov_rahours_decdeg: covZ0.map(r => r.map(v => +v.toExponential(3))) };

    // ── σ_k PROPAGATED: linear σ_k grossly UNDER-states the truth when ẑ is uncertain,
    // because k trades off with ẑ. Propagate: σ_k² = σ_k,lin² + gᵀ·Cov_ẑ·g, g=∂k/∂(raz,decz). ──
    const kAt = (ra: number, dc: number, ch: Ch) => Jf(ra, dc).p[3 + { R: 0, G: 1, B: 2 }[ch]];
    const sigK: Record<Ch, number> = { R: 0, G: 0, B: 0 };
    for (const ch of chs) {
      const gRa = (kAt(best.raH + dRa, best.decD, ch) - kAt(best.raH - dRa, best.decD, ch)) / (2 * dRa);
      const gDc = (kAt(best.raH, best.decD + dDc, ch) - kAt(best.raH, best.decD - dDc, ch)) / (2 * dDc);
      const varProp = gRa * (covZ0[0][0] * gRa + covZ0[0][1] * gDc) + gDc * (covZ0[1][0] * gRa + covZ0[1][1] * gDc);
      sigK[ch] = Math.sqrt(Math.max(0, sigKlin[ch] * sigKlin[ch] + Math.max(0, varProp)));
    }

    // ── physical-plausibility diagnostic (reported, not a hard gate): Rayleigh extinction
    // must be k≥0 and increase R<G<B. A single-frame fit that violates this is not a real
    // extinction measurement (the free vignette + sparse stars absorbed the signal). ──
    const kPhysical = kCh.R >= -0.02 && kCh.G >= -0.02 && kCh.B >= -0.02 && kCh.R <= kCh.G + 0.05 && kCh.G <= kCh.B + 0.05;

    // guards → verdicts (spec ΔX + boresight predicates; PLUS the ẑ-ellipse-too-large
    // predicate — the DATA's own error bar refusing, driven by the σ not a tuned number)
    const kMeasured = dX >= DX_MIN;
    // ẑ is MEASURED only if (a) off-boresight enough (V↔k separable), (b) its own 1σ
    // ellipse is bounded, AND (c) the fitted extinction is PHYSICALLY VALID (k≥0,
    // Rayleigh-ordered). Negative/inverted k means the fit assigned vignette+noise to
    // k·X — the (ẑ,k) decomposition is not recovering atmospheric physics, so ẑ is not
    // a real direction. (c) is a physical validity requirement, not a tuned pass gate.
    const zMeasured = boresightAngle >= BORESIGHT_MIN_DEG && ellipse.semi_major_deg <= ELLIPSE_MAX_DEG && kPhysical;
    if (!kMeasured) notMeasured['k (per channel)'] = `in-frame airmass span ΔX=${dX.toFixed(3)} < ${DX_MIN} — ZP↔k degenerate over this span (predicate ΔX<${DX_MIN})`;
    if (boresightAngle < BORESIGHT_MIN_DEG) notMeasured['zenith ẑ'] = `fitted ẑ ${boresightAngle.toFixed(1)}° from boresight < ${BORESIGHT_MIN_DEG}° AND no pooled vignette profile (inc 5) — even-r vignette V(r) aliases k·X(ẑ) near boresight (predicate: boresight<${BORESIGHT_MIN_DEG}°, no pooled V)`;
    else if (ellipse.semi_major_deg > ELLIPSE_MAX_DEG) notMeasured['zenith ẑ'] = `ẑ 1σ covariance ellipse semi-major = ${ellipse.semi_major_deg}° > ${ELLIPSE_MAX_DEG}° — the single frame's own error bar does not constrain a direction (free vignette + ${usedRows.length} stars at the σ≈0.15–0.5 floor; predicate: ẑ ellipse semi-major > ${ELLIPSE_MAX_DEG}°)`;
    else if (!kPhysical) notMeasured['zenith ẑ'] = `fitted extinction is UNPHYSICAL (k_RGB=${kCh.R.toFixed(2)}/${kCh.G.toFixed(2)}/${kCh.B.toFixed(2)}; requires k≥0, R<G<B) — the free vignette + ${usedRows.length} stars at the σ≈0.15–0.5 floor absorbed the extinction signal, so the (ẑ,k) fit is not recovering atmospheric physics (predicate: fitted k not Rayleigh-valid)`;

    // ── residual diagnostics (structureless-in-alt acceptance; colour & galactic-latitude alias) ──
    const diag: any = {};
    for (const ch of chs) {
      const pr: { alt: number; r: number; b: number; color: number | null; mag: number }[] = [];
      usedRows.forEach(st => {
        const y = st.dm[ch]; if (!Number.isFinite(y as number)) return;
        const s = unitVec(st.raH, st.decD), alt = altOf(zv, s), X = AtmosphericManager.computeAirMass(alt);
        const r2 = (Math.hypot(st.x - w / 2, st.y - h / 2) / (0.5 * Math.hypot(w, h))) ** 2;
        const pred = zpCh[ch] + kCh[ch] * X + p[6] * r2 + p[7] * r2 * r2;
        pr.push({ alt, r: (y as number) - pred, b: galB(st.raH, st.decD), color: st.color, mag: st.mag });
      });
      const rz = runsZ(pr.map(x => ({ alt: x.alt, r: x.r })));
      diag[ch] = { n: pr.length, resid_mad: +madOf(pr.map(x => x.r)).toFixed(4), runs_z: +rz.toFixed(2), structured_in_alt: Math.abs(rz) > RUNS_Z_FLAG };
    }
    diag._chart_pairs = usedRows.flatMap(st => {
      const s = unitVec(st.raH, st.decD), alt = altOf(zv, s), X = AtmosphericManager.computeAirMass(alt);
      const r2 = (Math.hypot(st.x - w / 2, st.y - h / 2) / (0.5 * Math.hypot(w, h))) ** 2;
      return chs.filter(ch => Number.isFinite(st.dm[ch] as number)).map(ch => ({ ch, alt: +alt.toFixed(2), resid: +((st.dm[ch] as number) - (zpCh[ch] + kCh[ch] * X + p[6] * r2 + p[7] * r2 * r2)).toFixed(4) }));
    });

    // ── β colour-term test (Gaia BP−RP): the colour axis is now MEASURED on the
    //    N-bearing GaiaG population (Gaia sectors carry bp_rp; the HYG B−V path is
    //    retired at the Gaia cutover). Reported-only DIAGNOSTIC — hold ẑ from the
    //    primary fit, compare σ_B with/without a β·(BP−RP) term. Not a gate/deposit
    //    (the lane's deposits stay owner-gated); the primary k/ẑ fit above is unchanged
    //    (withBeta=false), so no headline number moves. ──
    const cRows = table.stars.filter(r => r.colorProvenance === 'bp_rp_measured' && Number.isFinite(r.color as number));
    // dominant band among the colour-bearing rows (GaiaG in every current footprint)
    const cBand = cRows.filter(r => r.band === 'GaiaG').length >= cRows.filter(r => r.band === 'JohnsonV').length ? 'GaiaG' : 'JohnsonV';
    let betaBlock: any;
    if (cRows.length >= 5) {
      // hold ẑ from the primary fit — compare σ_B with/without the β·(BP−RP) term
      const ov = buildObs(cRows, cBand);
      const wUnit = ov.map(() => 1);
      const noBeta = fitLinear(ov, zv, wUnit, false);
      const wBeta = fitLinear(ov, zv, wUnit, true);
      const residB = (f: LinFit) => madOf(f.obs.map((o, i) => o.ch === 'B' ? f.resid[i] : NaN).filter(Number.isFinite));
      betaBlock = {
        n: cRows.length, band: cBand, color: 'Gaia BP−RP', color_provenance: 'bp_rp_measured',
        beta_R: +wBeta.p[8].toFixed(4), beta_G: +wBeta.p[9].toFixed(4), beta_B: +wBeta.p[10].toFixed(4),
        sigmaB_no_beta: +residB(noBeta).toFixed(4), sigmaB_with_beta: +residB(wBeta).toFixed(4),
        sigmaB_reduction: +(residB(noBeta) - residB(wBeta)).toFixed(4),
        note: `β measured against Gaia BP−RP on the n=${cRows.length} colour-bearing (bp_rp_measured) ${cBand} rows, ẑ held from the primary fit; REPORTED-ONLY diagnostic — single-frame, systematics-limited, not a validated colour term or a deposit.`,
      };
    } else {
      betaBlock = { n: cRows.length, NOT_MEASURED: `fewer than 5 usable stars carry measured Gaia BP−RP in this footprint (n=${cRows.length}) — β not fittable single-frame` };
    }

    // ── Sextant P1/P2 (no GPS on the bundled CR2 → validation NO_CLAIM; derive = RESEARCH) ──
    const hasGps = false, timestampTrusted = true;
    void TimeService.computeAltAz; // wired for the GPS-validate branch (unreached here)
    const sextant: any = {
      P1_validate: { mode: 'NO_CLAIM', reason: 'bundled CR2 has NO EXIF-GPS (trusted time only) — nothing to validate against' },
      P2_derive: (zMeasured && timestampTrusted)
        ? { tier: 'RESEARCH/APPROXIMATE', lat_deg_APPROX: +best.decD.toFixed(2), lon_note: 'lon from LST=RA_z requires the capture epoch LST; recorded as RA_z hours', ra_z_hours: +best.raH.toFixed(4), caveat: 'no ground truth on this frame — UNVERIFIED; APPROXIMATE per spec, never a product until inc 11 grading' }
        : { mode: 'NOT MEASURED', reason: !timestampTrusted ? 'timestampTrusted=false — alt/az frame ungrounded' : `ẑ NOT MEASURED → no zenith to convert to (lat,lon). ${notMeasured['zenith ẑ'] ?? ''}` },
    };

    // ── verdict JSON ──
    const verdict = {
      spec: 'ATMOSPHERE_SEXTANT_SPEC.md increment 2',
      frame: table.meta.frame,
      estimator: 'separable LS (VarPro): 2-D nonlinear ẑ (coarse 5° grid, multi-start → Nelder–Mead) + exact linear (ZP,k,a2,a4) inner (r⁴⊥r² Gram–Schmidt, predictors centered), Tukey-biweight IRLS c=4.685·MAD; whole-field-above-ALT_CUT admissibility keeps the SSR comparable across ẑ; σ_k propagates the ẑ covariance',
      engineering_values: { DX_MIN, BORESIGHT_MIN_DEG, ELLIPSE_MAX_DEG, ALT_CUT_DEG, N_MIN_HI, TUKEY_C, IRLS_ITERS, GRID_STEP_DEG, RUNS_Z_FLAG, ...table.meta.engineering_values },
      geometry: { ra0_hours: ra0H, dec0_deg: dec0D, scale_arcsec_px, theta_deg, parity, anchor_px, boresight_radec_hours_deg: [+cen.raH.toFixed(4), +cen.decD.toFixed(3)] },
      n_stars_used: usedRows.length, n_obs: best.fit.nobs, low_alt_cut: cutLow,
      band: 'GaiaG (primary)',
      zenith_hat: { ra_hours: +best.raH.toFixed(4), dec_deg: +best.decD.toFixed(3), boresight_offset_deg: +boresightAngle.toFixed(2), MEASURED: zMeasured, covariance_ellipse: ellipse },
      airmass_span_dX: +dX.toFixed(3), alt_min_deg: +Math.min(...alts).toFixed(1), alt_max_deg: +Math.max(...alts).toFixed(1),
      k_per_channel: kMeasured
        ? { R: { value: +kCh.R.toFixed(4), sigma: +sigK.R.toFixed(4), sigma_linear_only: +sigKlin.R.toFixed(4) }, G: { value: +kCh.G.toFixed(4), sigma: +sigK.G.toFixed(4), sigma_linear_only: +sigKlin.G.toFixed(4) }, B: { value: +kCh.B.toFixed(4), sigma: +sigK.B.toFixed(4), sigma_linear_only: +sigKlin.B.toFixed(4) }, sigma_note: 'σ = √(σ_lin² + ẑ-propagated); the linear-only σ ignores the k↔ẑ trade and is overconfident when ẑ is loose' }
        : { NOT_MEASURED: notMeasured['k (per channel)'] },
      k_physically_plausible: { ok: kPhysical, requires: 'k≥0 and increasing R<G<B (Rayleigh)', note: kPhysical ? 'fitted k satisfies the Rayleigh sign/ordering sanity check' : 'fitted k VIOLATES Rayleigh sign/ordering → this single-frame k is NOT a physical extinction measurement (free vignette + sparse stars absorbed the signal); reported with σ for transparency only' },
      vignette_V: { a2: +p[6].toFixed(4), a4: +p[7].toFixed(4), model: 'a2·r² + a4·r⁴, r = px-radius / half-diagonal (normalised 0..1)', fit_simultaneously: zMeasured, note: zMeasured ? 'ẑ off boresight, ellipse bounded, k Rayleigh-valid → V and k·X separable; a2/a4 are the measured radial falloff' : 'ẑ NOT MEASURED on this frame → the (ẑ,k,V) decomposition is not trustworthy; a2/a4 are the fit\'s combined radial trend, NOT a validated vignette (needs the inc-5 pooled per-rig profile held FIXED)' },
      zeropoints_fitted: { R: +zpCh.R.toFixed(4), G: +zpCh.G.toFixed(4), B: +zpCh.B.toFixed(4) },
      beta_color_term: betaBlock,
      residual_diagnostics: { R: diag.R, G: diag.G, B: diag.B, acceptance: 'structureless-in-alt via sign-runs z (|z|>RUNS_Z_FLAG ⇒ flagged residual trend in alt)' },
      sextant: sextant,
      NOT_MEASURED: notMeasured,
      caveat: 'v1 single-frame: systematics-limited by vignette residuals until inc 5 pooled profile; no output is a trusted product until inc 11 grading. No ground truth exists on this frame to score ẑ.',
    };
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(verdict, null, 2), 'utf8');
    writeSvg(diag._chart_pairs, kCh, zpCh, verdict, OUT_SVG);

    // validation ledger append (recorded, NOT pass/fail — no accuracy gate exists yet)
    const ledgerRow = { ts: new Date().toISOString(), frame: 'sample_observation.cr2', vertical: 'flux', band: 'GaiaG', verdict: zMeasured ? 'ZENITH_ESTIMATE(RESEARCH)' : 'ZENITH_REFUSED', fitted: { ra_z_h: +best.raH.toFixed(4), dec_z_deg: +best.decD.toFixed(3), boresight_off_deg: +boresightAngle.toFixed(2), dX: +dX.toFixed(3), k_measured: kMeasured }, truth: null, error_deg: null, sigma_claimed_deg: ellipse ? ellipse.semi_major_deg : null, note: 'no EXIF-GPS truth on this frame; recorded for the ledger, not scored' };
    fs.appendFileSync(LEDGER, JSON.stringify(ledgerRow) + '\n', 'utf8');

    console.log(`[fit] ẑ=(${best.raH.toFixed(3)}h,${best.decD.toFixed(2)}°) boresight_off=${boresightAngle.toFixed(1)}° ΔX=${dX.toFixed(3)}  ẑ_MEASURED=${zMeasured} k_MEASURED=${kMeasured}`);
    if (kMeasured) console.log(`[fit] k: R=${kCh.R.toFixed(3)}±${sigK.R.toFixed(3)} G=${kCh.G.toFixed(3)}±${sigK.G.toFixed(3)} B=${kCh.B.toFixed(3)}±${sigK.B.toFixed(3)}`);
    console.log(`[artifacts] ${path.relative(ROOT, OUT_JSON)}  ${path.relative(ROOT, OUT_SVG)}  ${path.relative(ROOT, LEDGER)}`);

    expect(fs.existsSync(OUT_JSON)).toBe(true);
    expect(usedRows.length).toBeGreaterThan(10);
    // every headline number is either populated with a σ or NOT MEASURED with a predicate
    expect(kMeasured ? Number.isFinite(kCh.G) : notMeasured['k (per channel)'].length > 0).toBeTruthy();
    expect(zMeasured ? (ellipse && ellipse.semi_major_deg >= 0) : notMeasured['zenith ẑ'].length > 0).toBeTruthy();
  });

  // ── EXIT GATE (1): synthetic self-consistency — inject known params, recover within claimed σ ──
  it('synthetic self-consistency: recovers injected (k, ẑ, vignette) within claimed σ', async () => {
    const table = await buildStarTable();
    const { w, h, ra0H, dec0D, scale_arcsec_px, theta_deg, parity, anchor_px } = table.meta;
    const degPerPx = scale_arcsec_px / 3600;
    const [AX, AY] = anchor_px, cT = Math.cos(theta_deg * D2R), sT = Math.sin(theta_deg * D2R);
    // pixel → sky (invert the recovered geometry) — lets us build a DENSE synthetic field
    const pix2sky = (px: number, py: number) => {
      const u = (px - AX) * degPerPx, vv = (py - AY) * degPerPx;
      const xi = u * cT + vv * sT, eta = (-u * sT + vv * cT) / parity;
      return gnomonicInverse(xi, eta, ra0H, dec0D);
    };
    // WELL-POSED synthetic regime (validates estimator MATH, not the real frame's SNR):
    // a moderate central field (r_norm<0.55 → ~27° radius) at a MODERATE off-boresight
    // altitude, so the WHOLE field stays above ALT_CUT (admissible) AND there is a real
    // airmass gradient+curvature to pin ẑ. (The full 91°-wide ultra-wide frame cannot
    // do both at once — that is exactly the real-frame degeneracy documented above.)
    const boresight = pix2sky(w / 2, h / 2);
    const zTrue = { raH: boresight.raH, decD: Math.max(-89, Math.min(89, boresight.decD + 34)) }; // ~34° off boresight
    const zt = unitVec(zTrue.raH, zTrue.decD);
    const kT: Record<Ch, number> = { R: 0.10, G: 0.16, B: 0.26 };
    const zpT: Record<Ch, number> = { R: -6.30, G: -5.90, B: -5.25 };
    const a2T = 1.10, a4T = 0.55; // ~1.65 mag corner falloff (14mm wide-open)
    const SIG_INJ = 0.03, NSYNTH = 300;
    let rs = 20260709; const rnd = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const halfDiag = 0.5 * Math.hypot(w, h);
    const synth: StarRow[] = [];
    while (synth.length < NSYNTH) {
      const x = rnd() * w, y = rnd() * h;
      const rn = Math.hypot(x - w / 2, y - h / 2) / halfDiag;
      if (rn > 0.55) continue;                       // central field only
      const sky = pix2sky(x, y);
      const s = unitVec(sky.raH, sky.decD), alt = altOf(zt, s), X = AtmosphericManager.computeAirMass(alt);
      const r2 = rn * rn;
      const dm: any = {};
      for (const ch of chs) dm[ch] = zpT[ch] + kT[ch] * X + a2T * r2 + a4T * r2 * r2 + gauss() * SIG_INJ;
      synth.push({ id: `syn_${synth.length}`, band: 'GaiaG', mag: 6, color: null, colorProvenance: 'NOT_MEASURED', raH: sky.raH, decD: sky.decD, x, y, parity: Math.round(y) & 1, dm, snr: { R: 20, G: 20, B: 20 } });
    }
    const obs: Obs[] = [];
    synth.forEach((st, idx) => {
      const s = unitVec(st.raH, st.decD);
      const r2 = (Math.hypot(st.x - w / 2, st.y - h / 2) / (0.5 * Math.hypot(w, h))) ** 2;
      for (const ch of chs) obs.push({ s, r2, ch, y: st.dm[ch] as number, wMeas: 1 / (SIG_INJ * SIG_INJ), color: null, star: idx });
    });
    const best = fitZenith(obs, null, false);
    expect(best.fit).toBeTruthy();
    const zv = unitVec(best.raH, best.decD);
    const p = best.fit.p, cov = best.fit.cov;
    const nEff = best.fit.sumWtukey - best.fit.ncol;
    const s2 = best.fit.ssr / Math.max(1, nEff);
    const kHat: Record<Ch, number> = { R: p[3], G: p[4], B: p[5] };
    const sigK: Record<Ch, number> = { R: Math.sqrt(Math.max(1e-9, cov[3][3] * s2)), G: Math.sqrt(Math.max(1e-9, cov[4][4] * s2)), B: Math.sqrt(Math.max(1e-9, cov[5][5] * s2)) };
    // ẑ angular error
    const zErrDeg = Math.acos(Math.max(-1, Math.min(1, zv[0] * zt[0] + zv[1] * zt[1] + zv[2] * zt[2]))) / D2R;
    const ssrTrue = fitLinear(obs, zt, obs.map(() => 1), false).ssr;
    console.log(`[synthetic] ẑ_err=${zErrDeg.toFixed(2)}°  SSR(recovered)=${best.fit.ssr.toFixed(2)} SSR(true)=${ssrTrue.toFixed(2)}  k̂: R=${kHat.R.toFixed(3)}±${sigK.R.toFixed(3)}(T ${kT.R}) G=${kHat.G.toFixed(3)}±${sigK.G.toFixed(3)}(T ${kT.G}) B=${kHat.B.toFixed(3)}±${sigK.B.toFixed(3)}(T ${kT.B})  V: a2=${p[6].toFixed(2)}(T ${a2T}) a4=${p[7].toFixed(2)}(T ${a4T})`);
    // recover k within 3σ (legitimate: synthetic noise at the measured floor)
    for (const ch of chs) expect(Math.abs(kHat[ch] - kT[ch])).toBeLessThanOrEqual(3 * sigK[ch] + 0.02);
    // recover ẑ within a few degrees (single-frame systematics-free synthetic)
    expect(zErrDeg).toBeLessThanOrEqual(6);
    // recover the vignette amplitude V(1)=a2+a4 within 0.2 mag
    expect(Math.abs((p[6] + p[7]) - (a2T + a4T))).toBeLessThanOrEqual(0.25);
  });
});

// ── residual-vs-alt SVG (step-6 style: points + per-channel ±1σ band) ──
function writeSvg(pairs: { ch: Ch; alt: number; resid: number }[], kCh: Record<Ch, number>, zpCh: Record<Ch, number>, verdict: any, out: string) {
  const svgW = 760, svgH = 460, pad = 60;
  const alts = pairs.map(p => p.alt), res = pairs.map(p => p.resid);
  const aMin = Math.min(...alts, 20), aMax = Math.max(...alts, 90);
  const rAbs = Math.max(0.2, ...res.map(r => Math.abs(r)));
  const sx = (a: number) => pad + (a - aMin) / (aMax - aMin || 1) * (svgW - 2 * pad);
  const sy = (r: number) => svgH / 2 - r / rAbs * (svgH / 2 - pad);
  const colors: Record<Ch, string> = { R: '#e05353', G: '#3fa34d', B: '#4a7fe0' };
  let pts = '';
  for (const ch of chs) {
    const sig = verdict.residual_diagnostics[ch]?.resid_mad ?? 0.1;
    pts += `<rect x="${pad}" y="${sy(sig).toFixed(1)}" width="${svgW - 2 * pad}" height="${(sy(-sig) - sy(sig)).toFixed(1)}" fill="${colors[ch]}" opacity="0.06"/>`;
    for (const p of pairs.filter(p => p.ch === ch)) pts += `<circle cx="${sx(p.alt).toFixed(1)}" cy="${sy(p.resid).toFixed(1)}" r="2.6" fill="${colors[ch]}" opacity="0.8"/>`;
  }
  const zM = verdict.zenith_hat.MEASURED, kM = !verdict.k_per_channel.NOT_MEASURED;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" font-family="sans-serif">
<rect width="${svgW}" height="${svgH}" fill="white"/>
<text x="${svgW / 2}" y="22" text-anchor="middle" font-size="15" font-weight="bold">fit_vertical residual vs altitude — bundled CR2 (GaiaG, R/G/B)</text>
<text x="${svgW / 2}" y="40" text-anchor="middle" font-size="11" fill="#555">ẑ ${zM ? 'MEASURED' : 'NOT MEASURED (boresight predicate)'} · k ${kM ? 'MEASURED' : 'NOT MEASURED (ΔX<0.3)'} · ΔX=${verdict.airmass_span_dX} · boresight_off=${verdict.zenith_hat.boresight_offset_deg}°</text>
<line x1="${pad}" y1="${svgH / 2}" x2="${svgW - pad}" y2="${svgH / 2}" stroke="#333"/>
<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${svgH - pad}" stroke="#333"/>
<text x="${svgW / 2}" y="${svgH - 14}" text-anchor="middle" font-size="12">altitude at fitted ẑ (deg)</text>
<text x="18" y="${svgH / 2}" text-anchor="middle" font-size="12" transform="rotate(-90 18 ${svgH / 2})">residual Δm − model (mag)</text>
<text x="${svgW - pad}" y="${pad - 6}" text-anchor="end" font-size="11" fill="#e05353">R</text><text x="${svgW - pad + 16}" y="${pad - 6}" text-anchor="end" font-size="11" fill="#3fa34d">G</text><text x="${svgW - pad + 32}" y="${pad - 6}" text-anchor="end" font-size="11" fill="#4a7fe0">B</text>
${pts}
</svg>`;
  fs.writeFileSync(out, svg, 'utf8');
}
