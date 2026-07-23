// Reproducible derivation of the FUJINON_XF23_F2 nominal distortion prior
// (src/engine/pipeline/m2_hardware/lens_profiles.ts). Converts the public
// lensfun ptlens model to the engine's even-only Brown-Conrady (k1,k2) at
// HALF-DIAGONAL normalization. Run: `node tools/psf/fuji_xf23_ptlens_to_bc.mjs`.
//
// SOURCE (LGPL): lensfun data/db/mil-fujifilm.xml, <model>XF23mmF2 R WR</model>.
//   ptlens:  r_d = r_u*(a*r_u^3 + b*r_u^2 + c*r_u + (1-a-b-c)),  r normalized to
//   HALF the SHORTER side. Engine normalizes r to the HALF-DIAGONAL and is
//   EVEN-only (f = 1 + k1*r^2 + k2*r^4). The factor f=r_d/r_u is a pure ratio
//   (normalization-independent), so f_ours(gamma*r) == f_lensfun(r), with
//   gamma = half_short/half_diag = 1/sqrt((3/2)^2+1) for the native 3:2 frame.
//   Overall radial scale is degenerate with the plate scale a blind solve fits,
//   so we least-squares the differential SHAPE: fit (fL-1) ~ lambda + k1*rO^2 +
//   k2*rO^4 over the real rectangular frame (area weighting), discard lambda.
const a = 0.0289722, b = -0.0763625, c = 0.0493558;
const d = 1 - a - b - c;
const A = 1.5, gamma = 1 / Math.sqrt(A * A + 1);
const fL = (x) => a * x * x * x + b * x * x + c * x + d;
const W = 7728, H = 5152, cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy), step = 8;

let M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Rhs = [0, 0, 0];
const acc = (rO, g) => { const bb = [1, rO * rO, rO ** 4]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) M[i][j] += bb[i] * bb[j]; Rhs[i] += bb[i] * g; } };
for (let py = 0; py < H; py += step) for (let px = 0; px < W; px += step) {
  const rO = Math.hypot(px - cx, py - cy) / hd; acc(rO, fL(rO / gamma) - 1);
}
const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
const col = (k) => M.map((r, i) => r.map((v, j) => (j === k ? Rhs[i] : v)));
const D0 = det3(M), lambda = det3(col(0)) / D0, k1 = det3(col(1)) / D0, k2 = det3(col(2)) / D0;

let sumE2 = 0, maxE = 0, m = 0, peakL = 0;
for (let py = 0; py < H; py += step) for (let px = 0; px < W; px += step) {
  const rho = Math.hypot(px - cx, py - cy), rO = rho / hd, fLp = fL(rO / gamma);
  const e = Math.abs((k1 * rO * rO + k2 * rO ** 4) - (fLp - 1 - lambda)) * rho;
  sumE2 += e * e; maxE = Math.max(maxE, e); m++; peakL = Math.max(peakL, Math.abs(fLp - 1) * rho);
}
console.log(`gamma=${gamma.toFixed(6)}  lambda(discarded)=${lambda.toFixed(6)}`);
console.log(`k1=${k1.toFixed(6)}  k2=${k2.toFixed(6)}  (half-diagonal norm, stored rounded to -0.0420 / 0.0375)`);
console.log(`SHAPE residual RMS=${Math.sqrt(sumE2 / m).toFixed(2)}px  max=${maxE.toFixed(2)}px  peak lensfun shift=${peakL.toFixed(2)}px on ${W}x${H}`);
