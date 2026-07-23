// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — MESH-COMPLETION ADMISSION GATE (legs 1+3; leg 2 = STUB interface)
// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH INCUBATOR (LAW-4, tools/ only, banked data only — nothing feeds a
// solve, no engine wiring, no constants moved). This is the ADMISSION CONTROL
// the graduation campaign called for (mesh_graduation GRADUATION_VERDICT
// blockers: corner false-rate ~20% + confusion-density guard). It decides, per
// mesh completion, whether to ADMIT it and at what fidelity — WITHOUT consulting
// the oracle. The oracle is used ONLY to LABEL each completion true/false so the
// gate's operating characteristics can be measured retroactively.
//
// The gate NEVER modifies mesh_finder.mjs or quad_walk_planner.mjs (a parallel
// lane experiments against those). It is a pure post-hoc admission layer that
// consumes their banked matches JSON.
//
// LEG 1 — GEOMETRIC CONSENSUS (no pixels, no oracle):
//   A completion admits only with k-quad agreement: >= K_CONS independent
//   (disjoint-support) parent triples of already-matched stars whose exact
//   3-point affine each predict the completion's image position within eps of
//   the MEASURED centroid, AND the residual |measured - localAffinePred| inside
//   the local affine's PROPAGATED uncertainty. The propagation cites the
//   quad_walk_planner conditioning-risk math (condPenalty eigen-ratio of the
//   neighbour tangent scatter) + a leverage term (extrapolation inflates the
//   predictor variance). Prior art READ, not modified.
//     Mechanism: a confusion false-completion has its centroid locked onto a
//     bright neighbour several FWHM off the true catalog position; independent
//     local triples still predict ~truth, so they DISAGREE with the drifted
//     centroid -> < K_CONS agree -> REFUSE. A clean true completion sits where
//     local geometry predicts -> consensus holds -> ADMIT.
//
// LEG 3 — CONFUSION ROUTING (catalog stars/beam; prior art density_metric.mjs
//   @2d6bc94b + depth_guard v2 dominance rule):
//     clean beam (<=1 catalog member in a FWHM beam)  -> FULL_ACCEPT
//     crowded beam, target dominant (brightest by >=DM)-> POSITION_ONLY
//                                                          (photometry NOT_MEASURED)
//     crowded beam, a brighter member present          -> REFUSE (blend)
//
// LEG 2 — FDR EXISTENCE (STUB ONLY): a documented seam. Post-train it plugs the
//   completion's forced-photometry SNR into the hardened per-star + set-level
//   forced-confirm family-wise gate (m6_plate_solve/forced_confirm.ts,
//   SOLVER_CONFIRM_SET_EXCESS_Z). NOT reimplemented here — legLbFdrStub() returns
//   DEFERRED and the seam contract is documented at leg2FdrExistence().
//
//   node tools/mesh/completion_gate.mjs --frame M66 \
//     --matches   D:/AstroLogic/test_artifacts/mesh_finder_2026-07-22/M66_mesh_matches.json \
//     --meta      D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_capture_meta.json \
//     --oracle-wcs D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/oracle_m66/m66.wcs \
//     [--stars stars.arrow] [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward } from '../psf/forced_detect.mjs';
import { solveLinear } from '../psf/imaging.mjs';
import { fitLocalAffine } from './mesh_finder.mjs';

const D2R = Math.PI / 180;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ── oracle a.net SIP .wcs parse + sky->pixel (VERBATIM from quad_walk_planner /
//    depth_guard / grade_oracle so the truth-labelling is byte-for-byte the
//    banked oracle grader) ────────────────────────────────────────────────────
export function parseAnetWcs(wcsPath) {
  const buf = fs.readFileSync(wcsPath); const c = {};
  for (let o = 0; o + 80 <= buf.length; o += 80) {
    const card = buf.toString('latin1', o, o + 80); const k = card.slice(0, 8).trim();
    if (k === 'END') break;
    if (card[8] === '=') { let v = card.slice(9).split('/')[0].trim(); if (v.startsWith("'")) v = v.replace(/'/g, '').trim(); else v = Number(v); c[k] = v; }
  }
  const order = (p) => (Number.isFinite(c[`${p}_ORDER`]) ? c[`${p}_ORDER`] : 0);
  const coefMat = (p) => { const n = order(p); const m = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)); for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const key = `${p}_${i}_${j}`; if (Number.isFinite(c[key])) m[i][j] = c[key]; } return m; };
  return { crpix: [c.CRPIX1, c.CRPIX2], crval: [c.CRVAL1, c.CRVAL2], cd: [[c.CD1_1, c.CD1_2], [c.CD2_1, c.CD2_2]], A: coefMat('A'), B: coefMat('B'), AP: coefMat('AP'), BP: coefMat('BP'), a_order: order('A'), ap_order: order('AP') };
}
function poly(m, u, v) { let s = 0, up = 1; for (let i = 0; i < m.length; i++) { let vq = 1; for (let j = 0; j < m[i].length; j++) { if (m[i][j]) s += m[i][j] * up * vq; vq *= v; } up *= u; } return s; }
export function makeSkyToPixel(w) {
  const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0]; const useInv = w.ap_order >= 2;
  return (raDeg, decDeg) => {
    const p = tanForward(raDeg, decDeg, w.crval[0], w.crval[1]); if (!p) return null;
    const U = (w.cd[1][1] * p.xi - w.cd[0][1] * p.eta) / det;
    const V = (-w.cd[1][0] * p.xi + w.cd[0][0] * p.eta) / det;
    let x, y;
    if (useInv) { x = w.crpix[0] + U + poly(w.AP, U, V); y = w.crpix[1] + V + poly(w.BP, U, V); }
    else { let ox = U, oy = V; for (let it = 0; it < 12; it++) { const nx = U - poly(w.A, ox, oy), ny = V - poly(w.B, ox, oy); if (Math.abs(nx - ox) < 1e-3 && Math.abs(ny - oy) < 1e-3) { ox = nx; oy = ny; break; } ox = nx; oy = ny; } x = w.crpix[0] + ox; y = w.crpix[1] + oy; }
    return { x, y };
  };
}

// ── inverse gnomonic: (xi,eta) standard-coords deg about (ra0,dec0) -> (ra,dec)
//    deg. Exact inverse of forced_detect.tanForward, so a completion's catalog
//    (ra,dec) is recovered from its banked xi/eta WITHOUT re-loading the atlas.
export function invTangent(xiDeg, etaDeg, ra0Deg, dec0Deg) {
  const X = xiDeg * D2R, Y = etaDeg * D2R;
  const d0 = dec0Deg * D2R;
  const rho = Math.hypot(X, Y);
  if (rho < 1e-12) return { ra_deg: ra0Deg, dec_deg: dec0Deg };
  const c = Math.atan(rho), sinc = Math.sin(c), cosc = Math.cos(c);
  const dec = Math.asin(cosc * Math.sin(d0) + Y * sinc * Math.cos(d0) / rho) / D2R;
  const ra = ra0Deg + Math.atan2(X * sinc, rho * Math.cos(d0) * cosc - Y * Math.sin(d0) * sinc) / D2R;
  return { ra_deg: ((ra % 360) + 360) % 360, dec_deg: dec };
}

// ── tangent kNN grid (mirror mesh_finder/planner buildTanGrid/kNearest) ───────
function buildTanGrid(items, cellDeg) { const map = new Map(); for (let i = 0; i < items.length; i++) { const gx = Math.floor(items[i].xi / cellDeg); const gy = Math.floor(items[i].eta / cellDeg); const k = gx * 1000003 + gy; let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); } return { map, cell: cellDeg, items }; }
function kNearest(grid, xi, eta, want, maxReach = 14) { const { map, cell, items } = grid; const gx = Math.floor(xi / cell), gy = Math.floor(eta / cell); const found = []; let reach = 1; while (reach <= maxReach) { found.length = 0; for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) { const a = map.get((gx + dx) * 1000003 + (gy + dy)); if (!a) continue; for (const pi of a) { const it = items[pi]; const d2 = (it.xi - xi) ** 2 + (it.eta - eta) ** 2; found.push({ idx: pi, d2 }); } } if (found.length >= want + 1 || reach === maxReach) break; reach++; } found.sort((a, b) => a.d2 - b.d2); return found.slice(0, want + 1); /* +1 so self can be dropped */ }

// ── exact 3-point affine (xi,eta)->(x,y); null if the src triangle is degenerate
function affine3(src, dst) {
  const M = new Float64Array(9), bx = new Float64Array(3), by = new Float64Array(3);
  for (let i = 0; i < 3; i++) { const g = [src[i].xi, src[i].eta, 1]; for (let r = 0; r < 3; r++) { bx[r] += g[r] * dst[i].x; by[r] += g[r] * dst[i].y; for (let c = 0; c < 3; c++) M[r * 3 + c] += g[r] * g[c]; } }
  const cx = solveLinear(M.slice(), bx.slice(), 3); if (!cx) return null;
  const cy = solveLinear(M.slice(), by.slice(), 3); if (!cy) return null;
  return { ax: cx[0], bx: cx[1], cx: cx[2], ay: cy[0], by: cy[1], cy: cy[2] };
}
const applyAff = (A, xi, eta) => [A.ax * xi + A.bx * eta + A.cx, A.ay * xi + A.by * eta + A.cy];

// ── conditioning penalty (VERBATIM logic from quad_walk_planner.condPenalty):
//    eigen-ratio of the neighbour tangent scatter; 1 => collinear/degenerate
//    (worst), 0 => isotropic (best). This is the planner's conditioning-risk
//    prior art, read and re-expressed, NOT imported-by-mutation.
function condPenalty(pts) {
  if (pts.length < 3) return 1;
  let mx = 0, my = 0; for (const p of pts) { mx += p.xi; my += p.eta; } mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { const ex = p.xi - mx, ey = p.eta - my; sxx += ex * ex; syy += ey * ey; sxy += ex * ey; }
  const tr = sxx + syy, dt = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  return l1 > 1e-18 ? 1 - Math.sqrt(Math.max(0, l2 / l1)) : 1;
}
function tangentSpread(pts) { let mx = 0, my = 0; for (const p of pts) { mx += p.xi; my += p.eta; } mx /= pts.length; my /= pts.length; let s = 0; for (const p of pts) s += (p.xi - mx) ** 2 + (p.eta - my) ** 2; return { cx: mx, cy: my, rms: Math.sqrt(s / pts.length) }; }

// ═══════════════════════════════════════════════════════════════════════════
// LEG 2 — FDR EXISTENCE (STUB INTERFACE ONLY; not reimplemented here)
// ═══════════════════════════════════════════════════════════════════════════
// Seam contract for the post-train wiring. LEG 2 decides EXISTENCE (is there a
// real source here at all, controlling the false-discovery rate across the
// completion set) — orthogonal to LEG 1 (is it in the right PLACE) and LEG 3
// (is the flux ATTRIBUTABLE). It plugs into the already-hardened confirm
// machinery, it does NOT get a fresh FDR implementation in this lane.
//
// INPUT  (per completion, supplied post-train): { snr, sigma_local, flux,
//         n_ap } forced-photometry stats at the ADMITTED position + a set-level
//         family-wise budget (SOLVER_CONFIRM_SET_EXCESS_Z, N-calibrated).
// OUTPUT: { exists: bool, z, decision:'EXISTS'|'ABSENT'|'DEFERRED' }.
// WIRING TARGET: src/engine/pipeline/m6_plate_solve/forced_confirm.ts
//         (per-star ~2σ + set-level excess-Z, Benjamini-Hochberg-style FDR).
export function leg2FdrExistence(/* completionForcedStats, setBudget */) {
  return { decision: 'DEFERRED', exists: null, z: null, reason: 'FDR_EXISTENCE_STUB', wiring_target: 'src/engine/pipeline/m6_plate_solve/forced_confirm.ts (SOLVER_CONFIRM_SET_EXCESS_Z)', note: 'post-train seam; not reimplemented in the incubator lane' };
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE
// ═══════════════════════════════════════════════════════════════════════════
// matched: [{ id, mag, xi, eta, x, y, source }]  (seeds + completions)
// catGrid: pixel grid of catalog {x,y,mag,id} projected via meta WCS (LEG 3)
// P: tunable gate parameters
export function runGateOnMatches({ matched, completions, catPixGrid, catBeamR, W, H, FWHM, P }) {
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;
  const grid = buildTanGrid(matched, P.cellDeg);
  const sigmaFloorPx = Math.max(P.sigmaFloorPx, 0.5 * FWHM);

  const rows = [];
  for (const c of completions) {
    // ── neighbour support (drop self by id or coincident position) ──
    const knn = kNearest(grid, c.xi, c.eta, P.kNear + 1);
    const nb = [];
    for (const k of knn) { const m = matched[k.idx]; if (m.id === c.id) continue; if (Math.abs(m.xi - c.xi) < 1e-12 && Math.abs(m.eta - c.eta) < 1e-12) continue; nb.push({ ...m, d2: k.d2 }); if (nb.length >= P.kNear) break; }

    // ── LEG 1a: k-quad geometric consensus (independent disjoint triples) ──
    let consensusN = 0, consensusPreds = [], triplesTried = 0;
    // disjoint triples from the nearest 3*floor(kNear/3) neighbours
    const nTri = Math.floor(nb.length / 3);
    for (let t = 0; t < nTri; t++) {
      const tri = [nb[3 * t], nb[3 * t + 1], nb[3 * t + 2]];
      const A = affine3(tri, tri.map((s) => ({ x: s.x, y: s.y })));
      triplesTried++;
      if (!A) continue;
      const [px, py] = applyAff(A, c.xi, c.eta);
      consensusPreds.push([px, py]);
    }
    // ── LEG 1b: weighted K-neighbour affine + propagated uncertainty ──
    let affPred = null, affRms = null, cp = 1, lever = null, propSigma = null, residPx = null;
    if (nb.length >= P.kMin) {
      const wts = nb.map((n) => 1 / (n.d2 + 1e-9));
      const aff = fitLocalAffine(nb, nb.map((n) => ({ x: n.x, y: n.y })), wts);
      if (aff) {
        const [px, py] = applyAff(aff.A, c.xi, c.eta);
        affPred = [px, py]; affRms = aff.rms;
        cp = condPenalty(nb);
        const sp = tangentSpread(nb);
        lever = sp.rms > 1e-12 ? Math.hypot(c.xi - sp.cx, c.eta - sp.cy) / sp.rms : 99;
        propSigma = Math.max(sigmaFloorPx, affRms * Math.sqrt(1 + lever * lever) * (1 + P.condInflate * cp));
        residPx = Math.hypot(c.x - px, c.y - py);
      }
    }
    // Two DECOUPLED tolerances (this is what gives the gate teeth at the frontier):
    //  - consensus eps: tied to the IN-SAMPLE fit noise (affRms), NOT the leverage-
    //    inflated propagated sigma — so "do independent local triples agree with the
    //    measured centroid" stays a TIGHT test even where the predictor variance is
    //    large. A drifted confusion centroid fails it; a clean completion passes.
    //  - residual bar: tied to the PROPAGATED uncertainty (planner conditioning-risk
    //    math), CAPPED so an ill-conditioned frontier patch can't admit everything.
    const affScale = affRms != null ? affRms : sigmaFloorPx;
    const epsCons = Math.min(P.consCapFwhmMult * FWHM, Math.max(P.consNSigma * affScale, P.consFloorMult * FWHM));
    const scaleSigma = propSigma != null ? propSigma : sigmaFloorPx;
    const residBar = Math.min(P.residCapFwhmMult * FWHM, Math.max(P.residNSigma * scaleSigma, P.residFloorMult * FWHM));
    for (const [px, py] of consensusPreds) if (Math.hypot(c.x - px, c.y - py) <= epsCons) consensusN++;

    // LEG 1c: EXTRAPOLATION / conditioning risk (planner conditioning-risk math).
    // A completion predicted far outside the neighbour support hull (high
    // leverage) or from an ill-conditioned near-collinear patch (high cond
    // penalty) is untrustworthy REGARDLESS of the cascade-enforced residual —
    // this is the only local lever with signal on M66-class corner false-
    // completions (whose residual is ~0 by construction). Off by default
    // (Infinity); the OC sweep drives it.
    const leg1_extrap = (lever != null && lever > P.leverageRefuse) || (cp > P.condRefuse);
    const leg1_support = nb.length >= P.kMin && triplesTried >= P.kCons;
    const leg1_consensus = consensusN >= P.kCons;
    const leg1_residual = residPx != null && residPx <= residBar;
    const leg1_pass = leg1_support && leg1_consensus && leg1_residual && !leg1_extrap;
    const leg1_reason = !leg1_support ? 'INSUFFICIENT_SUPPORT' : (!leg1_consensus ? 'NO_KQUAD_CONSENSUS' : (!leg1_residual ? 'RESIDUAL_EXCEEDS_UNCERTAINTY' : (leg1_extrap ? 'EXTRAPOLATION_RISK' : 'OK')));

    // ── LEG 3: confusion routing (catalog stars/beam at measured position) ──
    const beam = catPixGrid.within(c.x, c.y, catBeamR);
    // self = the catalog member matching this completion's id (may be absent if
    // the measured centroid drifted a full beam off the meta-projected self).
    const selfMem = beam.find((m) => m.id === c.id) || null;
    const others = beam.filter((m) => m.id !== c.id);
    const brighterOthers = others.filter((m) => m.mag < c.mag - 1e-9);
    const mult = beam.length + (selfMem ? 0 : 1); // count target itself even if drifted off-beam
    let leg3_class, leg3_reason;
    if (others.length === 0) { leg3_class = 'CLEAN'; leg3_reason = 'isolated_beam'; }
    else if (brighterOthers.some((m) => m.mag <= c.mag - P.dmDominant)) { leg3_class = 'REFUSE'; leg3_reason = 'brighter_member_dominates'; }
    else if (brighterOthers.length > 0) { leg3_class = 'REFUSE'; leg3_reason = 'brighter_member_in_beam'; }
    else { leg3_class = 'POSITION_ONLY'; leg3_reason = 'crowded_target_dominant_photometry_not_measured'; }

    // ── LEG 2 stub ──
    const leg2 = leg2FdrExistence();

    // ── combined admission ──
    let decision, accept_class, reason_codes = [];
    if (!leg1_pass) { decision = 'REFUSE'; accept_class = 'REFUSE'; reason_codes.push('LEG1:' + leg1_reason); }
    else if (leg3_class === 'REFUSE') { decision = 'REFUSE'; accept_class = 'REFUSE'; reason_codes.push('LEG3:' + leg3_reason); }
    else if (leg3_class === 'POSITION_ONLY') { decision = 'ADMIT'; accept_class = 'POSITION_ONLY'; reason_codes.push('LEG3:' + leg3_reason); }
    else { decision = 'ADMIT'; accept_class = 'FULL_ACCEPT'; reason_codes.push('LEG1:OK', 'LEG3:CLEAN'); }

    rows.push({
      id: c.id, mag: +c.mag.toFixed(3), x: +c.x.toFixed(2), y: +c.y.toFixed(2), r_norm: c.r_norm ?? +rNorm(c.x, c.y).toFixed(4),
      leg1: { support_n: nb.length, triples: triplesTried, consensus_n: consensusN, consensus_pass: leg1_consensus, resid_px: residPx == null ? null : +residPx.toFixed(2), resid_bar_px: +residBar.toFixed(2), eps_cons_px: +epsCons.toFixed(2), aff_rms_px: affRms == null ? null : +affRms.toFixed(2), cond_penalty: +cp.toFixed(3), leverage: lever == null ? null : +lever.toFixed(2), prop_sigma_px: propSigma == null ? null : +propSigma.toFixed(2), pass: leg1_pass, reason: leg1_reason },
      leg3: { beam_members: mult, brighter_in_beam: brighterOthers.length, self_in_beam: !!selfMem, class: leg3_class, reason: leg3_reason },
      leg2,
      decision, accept_class, reason_codes,
    });
  }
  return rows;
}

// ── pixel grid for catalog confusion counts (project via meta WCS) ────────────
function makeCatPixGrid(catPix, cellPx) {
  const map = new Map();
  for (let i = 0; i < catPix.length; i++) { const k = (catPix[i].x / cellPx | 0) * 100003 + (catPix[i].y / cellPx | 0); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); }
  return {
    within(x, y, r) { const gx = x / cellPx | 0, gy = y / cellPx | 0; const reach = Math.ceil(r / cellPx); const out = []; const r2 = r * r; for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) { const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { const d2 = (catPix[i].x - x) ** 2 + (catPix[i].y - y) ** 2; if (d2 <= r2) out.push(catPix[i]); } } return out; },
  };
}

// ── operating characteristics per radial band ─────────────────────────────────
const BANDS = [{ id: '0.00-0.70', lo: 0, hi: 0.70 }, { id: '0.70-0.85', lo: 0.70, hi: 0.85 }, { id: '0.85-1.00', lo: 0.85, hi: 1.0001 }];
export function operatingCharacteristics(rows, labels) {
  // labels: Map id -> {isFalse:bool}
  const perBand = BANDS.map((b) => {
    const inBand = rows.filter((r) => r.r_norm >= b.lo && r.r_norm < b.hi);
    let nTrue = 0, nFalse = 0, trueAdmit = 0, falseAdmit = 0, trueRefuse = 0, falseRefuse = 0, nLabeled = 0;
    for (const r of inBand) { const lab = labels.get(r.id); if (!lab) continue; nLabeled++; const admit = r.decision === 'ADMIT'; if (lab.isFalse) { nFalse++; if (admit) falseAdmit++; else falseRefuse++; } else { nTrue++; if (admit) trueAdmit++; else trueRefuse++; } }
    const admittedN = trueAdmit + falseAdmit;
    return {
      band: b.id, n: inBand.length, n_labeled: nLabeled, n_true: nTrue, n_false: nFalse,
      baseline_false_rate: nLabeled ? +(nFalse / nLabeled).toFixed(3) : null,
      true_retention: nTrue ? +(trueAdmit / nTrue).toFixed(3) : null,
      false_kill: nFalse ? +(falseRefuse / nFalse).toFixed(3) : null,
      admitted_n: admittedN,
      accepted_false_rate: admittedN ? +(falseAdmit / admittedN).toFixed(3) : null,
    };
  });
  return perBand;
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE-FRAME CLI / reusable entry
// ═══════════════════════════════════════════════════════════════════════════
export function runCompletionGate({ frame, matchesPath, metaPath, oracleWcsPath, starsPath, magLimit = 15, P = {}, out = null }) {
  const params = {
    kNear: 12, kMin: 3, kCons: 2, cellDeg: 0.04,
    condInflate: 1.0, sigmaFloorPx: 1.5,
    consNSigma: 2, consFloorMult: 1.0, consCapFwhmMult: 2.0,
    residNSigma: 2, residFloorMult: 1.0, residCapFwhmMult: 2.5,
    leverageRefuse: Infinity, condRefuse: Infinity,
    dmDominant: 2.5, beamFwhmMult: 1.0,
    ...P,
  };
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const W = meta.width, H = meta.height;
  const wcs = meta.wcs; const crval = [wcs.CRVAL1, wcs.CRVAL2], crpix = [wcs.CRPIX1, wcs.CRPIX2];
  const cd = [[wcs.CD1_1, wcs.CD1_2], [wcs.CD2_1, wcs.CD2_2]];
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  const scaleArcsec = Math.sqrt(Math.abs(det)) * 3600;
  const FWHM = meta.mean_fwhm_px || 2.3;
  const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
  const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;

  const all = JSON.parse(fs.readFileSync(matchesPath, 'utf8')).matches;
  const matched = all.map((m) => ({ id: m.id, mag: m.mag, xi: m.xi, eta: m.eta, x: m.x, y: m.y, source: m.source }));
  const completions = all.filter((m) => m.source === 'mesh').map((m) => ({ ...m, r_norm: m.r_norm ?? +rNorm(m.x, m.y).toFixed(4) }));

  // LEG-3 catalog: project g15u into the frame via the META (operational) WCS.
  const coneR = Math.min(89, Math.atan(hd * (scaleArcsec / 3600) * D2R) / D2R + 2);
  const g15 = regionStars({ starsArrowPath: starsPath, raDeg: crval[0], decDeg: crval[1], radiusDeg: coneR, magLimit });
  const catPix = [];
  for (const s of g15) { const p = tanForward(s.ra_deg, s.dec_deg, crval[0], crval[1]); if (!p) continue; const x = crpix[0] + (cd[1][1] * p.xi - cd[0][1] * p.eta) / det; const y = crpix[1] + (-cd[1][0] * p.xi + cd[0][0] * p.eta) / det; if (x < -20 || y < -20 || x >= W + 20 || y >= H + 20) continue; catPix.push({ id: s.gaia_id, mag: s.mag, x, y }); }
  const catBeamR = params.beamFwhmMult * FWHM;
  const catPixGrid = makeCatPixGrid(catPix, Math.max(8, Math.ceil(catBeamR)));

  // gate
  const rows = runGateOnMatches({ matched, completions, catPixGrid, catBeamR, W, H, FWHM, P: params });

  // truth labels via oracle SIP (self-contained: invTangent(xi,eta;crval)->ra/dec)
  const owcs = parseAnetWcs(oracleWcsPath); const sky2truth = makeSkyToPixel(owcs);
  const tol2 = 2 * FWHM;
  const labels = new Map(); let noOra = 0;
  for (const c of completions) { const rd = invTangent(c.xi, c.eta, crval[0], crval[1]); const t = sky2truth(rd.ra_deg, rd.dec_deg); if (!t) { noOra++; continue; } const d = Math.hypot(c.x - t.x, c.y - t.y); labels.set(c.id, { isFalse: d > tol2, drift_px: d }); }
  // fold truth drift into rows for the overlay/audit
  for (const r of rows) { const lab = labels.get(r.id); r.truth_false = lab ? lab.isFalse : null; r.truth_drift_px = lab ? +lab.drift_px.toFixed(2) : null; }

  const oc = operatingCharacteristics(rows, labels);
  // meta pointing error (median |meta-proj self - measured| over seeds present in catalog)
  const catById = new Map(catPix.map((p) => [p.id, p]));
  const ptErr = [];
  for (const m of matched) { if (m.source !== 'seed') continue; const cp = catById.get(m.id); if (cp) ptErr.push(Math.hypot(cp.x - m.x, cp.y - m.y)); }

  const summary = {
    frame, generated: new Date().toISOString(),
    lane: 'tools/mesh/completion_gate.mjs (admission-controls incubator, LAW-4, banked-data only)',
    regime: 'ASSISTED-ORACLE labelling (a.net SIP truth; gate itself NEVER consults the oracle); NEVER pooled with blind-solve stats',
    inputs: { matches: matchesPath, meta: metaPath, oracle_wcs: oracleWcsPath, stars: starsPath },
    image: { w: W, h: H, scale_arcsec_px: +scaleArcsec.toFixed(3), fwhm_px: +FWHM.toFixed(3), tol_2fwhm_px: +tol2.toFixed(2), half_diag_px: +hd.toFixed(1) },
    catalog: { g15u_in_frame: catPix.length, cat_mag_limit: magLimit, cone_deg: +coneR.toFixed(2), leg3_beam_radius_px: +catBeamR.toFixed(2), meta_pointing_err_px_median: ptErr.length ? +median(ptErr).toFixed(2) : null },
    counts: { seeds: matched.length - completions.length, completions: completions.length, labeled: labels.size, no_oracle: noOra },
    params,
    decision_tally: rows.reduce((a, r) => { a[r.accept_class] = (a[r.accept_class] || 0) + 1; return a; }, {}),
    operating_characteristics: oc,
    leg2_seam: leg2FdrExistence(),
    provenance_notes: [
      'LEG 1 (geometric consensus) + LEG 3 (confusion routing) consult ONLY the mesh matched set and the g15u catalog projected via the FRAME meta WCS — never the oracle.',
      'The oracle a.net SIP is used ONLY to LABEL completions true/false (drift>2*FWHM) so operating characteristics can be measured retroactively (identical false definition to grade_oracle.mjs).',
      'LEG 2 (FDR existence) is a STUB seam (leg2FdrExistence) wired post-train into forced_confirm.ts; the accepted-false residual above the promotion bar is the headroom left for it.',
      'catalog (ra,dec) recovered from banked xi/eta via exact inverse-gnomonic (invTangent) — no atlas re-load needed for truth-labelling.',
    ],
  };
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${frame}_completion_gate.json`), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(out, `${frame}_completion_gate_rows.json`), JSON.stringify({ frame, n: rows.length, rows }, null, 2));
  }
  return { summary, rows, labels, W, H, FWHM, completions, matched, catPix };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const IS_MAIN = process.argv[1] && (() => { try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); } catch { return false; } })();
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const A = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const AN = (k, d) => { const v = A(k, null); return v == null ? d : parseFloat(v); };
  const P = {};
  for (const [flag, key] of [['--cons-nsigma', 'consNSigma'], ['--resid-nsigma', 'residNSigma'], ['--cons-floor-mult', 'consFloorMult'], ['--resid-floor-mult', 'residFloorMult'], ['--cons-cap-fwhm-mult', 'consCapFwhmMult'], ['--resid-cap-fwhm-mult', 'residCapFwhmMult'], ['--cond-inflate', 'condInflate'], ['--leverage-refuse', 'leverageRefuse'], ['--cond-refuse', 'condRefuse'], ['--dm-dominant', 'dmDominant'], ['--beam-fwhm-mult', 'beamFwhmMult'], ['--k-cons', 'kCons'], ['--k-near', 'kNear']]) { const v = A(flag, null); if (v != null) P[key] = parseFloat(v); }
  const r = runCompletionGate({
    frame: A('--frame', 'frame'),
    matchesPath: A('--matches'),
    metaPath: A('--meta'),
    oracleWcsPath: A('--oracle-wcs'),
    starsPath: A('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow'),
    magLimit: AN('--mag-limit', 15),
    P, out: A('--out', 'D:/AstroLogic/test_artifacts/admission_controls_2026-07-22'),
  });
  console.log(JSON.stringify({ frame: r.summary.frame, image: r.summary.image, counts: r.summary.counts, meta_pointing_err_px_median: r.summary.catalog.meta_pointing_err_px_median, decision_tally: r.summary.decision_tally, operating_characteristics: r.summary.operating_characteristics }, null, 2));
}
